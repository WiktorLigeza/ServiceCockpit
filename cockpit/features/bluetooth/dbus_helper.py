#!/usr/bin/python3
"""D-Bus side of the Bluetooth page.

Runs under the *system* python3 (python3-dbus + python3-gi aren't in the app's
venv) as a child of the app, talking JSON lines: commands on stdin, events on
stdout. It hosts the two things that need a D-Bus object of our own, which
bluetoothctl/busctl can't provide:

* A Serial Port Profile (SPP) registered with bluetoothd. Both incoming
  connections (a phone's serial-terminal app) and outgoing ones (Device1.
  ConnectProfile) arrive as an RFCOMM fd via NewConnection. Each link is
  bridged to a pty - so scripts can use it like a serial port through a stable
  symlink - and mirrored to the web terminal.
* An OBEX agent + client on the user session bus (obexd lives there): incoming
  file pushes are forwarded for accept/decline, outgoing files are pushed with
  Client1/ObjectPush1, and transfer progress is reported for both.
"""

import base64
import json
import os
import sys
import tty
import uuid

import dbus
import dbus.mainloop.glib
import dbus.service
from gi.repository import GLib

SPP_UUID = '00001101-0000-1000-8000-00805f9b34fb'
PROFILE_PATH = '/org/servicecockpit/serial'
OBEX_AGENT_PATH = '/org/servicecockpit/obex_agent'
PROPS = 'org.freedesktop.DBus.Properties'
SERIAL_LINK_DIR = '/tmp/bluetooth-serial'
RECEIVE_DIR = os.path.expanduser('~/Bluetooth')
AUTHORIZE_TIMEOUT = 60


def emit(event, **data):
    sys.stdout.write(json.dumps({'event': event, **data}) + '\n')
    sys.stdout.flush()


def mac_from_path(path):
    part = str(path).rsplit('/', 1)[-1]
    return part[4:].replace('_', ':') if part.startswith('dev_') else ''


def unique_path(folder, name):
    name = os.path.basename(name or '').strip().replace('\x00', '') or 'received-file'
    if name in ('.', '..'):
        name = 'received-file'
    base, ext = os.path.splitext(name)
    candidate, n = os.path.join(folder, name), 1
    while os.path.exists(candidate):
        candidate = os.path.join(folder, f'{base} ({n}){ext}')
        n += 1
    return candidate


class Rejected(dbus.DBusException):
    _dbus_error_name = 'org.bluez.obex.Error.Rejected'


class Canceled(dbus.DBusException):
    _dbus_error_name = 'org.bluez.obex.Error.Canceled'


# ---------------------------------------------------------------- serial

class SerialLink:
    def __init__(self, helper, mac, fd, direction):
        self.helper = helper
        self.mac = mac
        self.fd = fd
        self.direction = direction
        self.master, self.slave = os.openpty()
        # Raw so bytes pass through untouched (no echo / CRLF mangling). The
        # helper keeps the slave open itself so the master never sees EIO
        # while nothing else has the port open.
        tty.setraw(self.slave)
        os.set_blocking(self.master, False)
        self.pty = os.ttyname(self.slave)
        os.makedirs(SERIAL_LINK_DIR, exist_ok=True)
        self.link = os.path.join(SERIAL_LINK_DIR, mac.replace(':', '_'))
        try:
            if os.path.islink(self.link):
                os.unlink(self.link)
            os.symlink(self.pty, self.link)
        except OSError:
            self.link = None
        self.watches = [
            GLib.io_add_watch(self.fd, GLib.IO_IN | GLib.IO_HUP | GLib.IO_ERR, self._on_remote),
            GLib.io_add_watch(self.master, GLib.IO_IN | GLib.IO_HUP | GLib.IO_ERR, self._on_pty),
        ]
        self.closed = False

    def info(self):
        return {'mac': self.mac, 'direction': self.direction, 'pty': self.pty, 'link': self.link}

    def _on_remote(self, fd, cond):
        data = b''
        if cond & GLib.IO_IN:
            try:
                data = os.read(fd, 4096)
            except OSError:
                data = b''
        if not data:
            self.close('Remote side closed the connection')
            return False
        emit('serial_data', mac=self.mac, data=base64.b64encode(data).decode())
        try:
            os.write(self.master, data)
        except (BlockingIOError, OSError):
            pass  # nobody is reading the pty and its buffer is full
        return True

    def _on_pty(self, fd, cond):
        try:
            data = os.read(fd, 4096)
        except (BlockingIOError, OSError):
            return True
        if data:
            self.write(data)
        return True

    def write(self, data):
        try:
            os.write(self.fd, data)
            return True
        except OSError as e:
            self.close(f'Write failed: {e}')
            return False

    def close(self, reason=''):
        if self.closed:
            return
        self.closed = True
        for w in self.watches:
            GLib.source_remove(w)
        for fd in (self.fd, self.master, self.slave):
            try:
                os.close(fd)
            except OSError:
                pass
        if self.link:
            try:
                os.unlink(self.link)
            except OSError:
                pass
        self.helper.links.pop(self.mac, None)
        emit('serial_closed', mac=self.mac, reason=reason)


class SerialProfile(dbus.service.Object):
    def __init__(self, bus, helper):
        super().__init__(bus, PROFILE_PATH)
        self.helper = helper

    @dbus.service.method('org.bluez.Profile1', in_signature='oha{sv}', out_signature='')
    def NewConnection(self, device, fd, properties):
        mac = mac_from_path(device)
        fd = fd.take()
        old = self.helper.links.get(mac)
        if old:
            old.close('Replaced by a new connection')
        direction = 'outgoing' if mac in self.helper.connecting else 'incoming'
        self.helper.connecting.discard(mac)
        link = SerialLink(self.helper, mac, fd, direction)
        self.helper.links[mac] = link
        emit('serial_opened', **link.info())

    @dbus.service.method('org.bluez.Profile1', in_signature='o', out_signature='')
    def RequestDisconnection(self, device):
        link = self.helper.links.get(mac_from_path(device))
        if link:
            link.close('Disconnected')

    @dbus.service.method('org.bluez.Profile1', in_signature='', out_signature='')
    def Release(self):
        pass


# ---------------------------------------------------------------- obex

class ObexAgent(dbus.service.Object):
    def __init__(self, bus, helper):
        super().__init__(bus, OBEX_AGENT_PATH)
        self.helper = helper

    @dbus.service.method('org.bluez.obex.Agent1', in_signature='o', out_signature='s',
                         async_callbacks=('reply', 'error'))
    def AuthorizePush(self, transfer, reply, error):
        props = self.helper.transfer_props(transfer)
        request_id = uuid.uuid4().hex
        name = str(props.get('Name') or 'received-file')
        self.helper.pending[request_id] = (reply, error, name, str(transfer))
        self.helper.transfers[str(transfer)] = {
            'direction': 'incoming', 'name': name, 'size': int(props.get('Size') or 0),
            'mac': props.get('mac', ''),
        }
        emit('obex_authorize', id=request_id, transfer=str(transfer), name=name,
             size=int(props.get('Size') or 0), type=str(props.get('Type') or ''), mac=props.get('mac', ''))
        GLib.timeout_add_seconds(AUTHORIZE_TIMEOUT, self.helper.expire_request, request_id)

    @dbus.service.method('org.bluez.obex.Agent1', in_signature='', out_signature='')
    def Cancel(self):
        for request_id in list(self.helper.pending):
            self.helper.answer_push(request_id, False, notify='canceled')

    @dbus.service.method('org.bluez.obex.Agent1', in_signature='', out_signature='')
    def Release(self):
        pass


# ---------------------------------------------------------------- helper

class Helper:
    def __init__(self):
        dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
        self.loop = GLib.MainLoop()
        self.system = dbus.SystemBus()
        self.links = {}
        self.connecting = set()
        self.pending = {}
        self.transfers = {}
        self.sessions = {}
        self.profile = SerialProfile(self.system, self)
        self.serial_ready = False
        self.session = None
        self.obex_ready = False
        self._buf = b''

    # -- setup -----------------------------------------------------------

    def register_profile(self, *_):
        try:
            manager = dbus.Interface(self.system.get_object('org.bluez', '/org/bluez'), 'org.bluez.ProfileManager1')
            manager.RegisterProfile(PROFILE_PATH, SPP_UUID, {
                'Name': dbus.String('ServiceCockpit Serial'),
                'AutoConnect': dbus.Boolean(False),
                'RequireAuthentication': dbus.Boolean(True),
            })
            self.serial_ready = True
            emit('status', feature='serial', ready=True)
        except dbus.DBusException as e:
            self.serial_ready = 'AlreadyExists' in e.get_dbus_name()
            emit('status', feature='serial', ready=self.serial_ready, error=None if self.serial_ready else e.get_dbus_message())

    def _on_bluez_owner(self, owner):
        # bluetoothd (re)started - profile registrations don't survive that.
        if owner:
            GLib.timeout_add(500, lambda: self.register_profile() and False)
        else:
            self.serial_ready = False
            for link in list(self.links.values()):
                link.close('Bluetooth service stopped')

    def setup_obex(self):
        try:
            self.session = dbus.SessionBus()
        except dbus.DBusException as e:
            emit('status', feature='files', ready=False, error=f'No user session bus: {e.get_dbus_message()}')
            return
        try:
            self.obex_agent = ObexAgent(self.session, self)
            manager = dbus.Interface(self.session.get_object('org.bluez.obex', '/org/bluez/obex'), 'org.bluez.obex.AgentManager1')
            manager.RegisterAgent(OBEX_AGENT_PATH)
            self.session.add_signal_receiver(
                self._on_transfer_changed, 'PropertiesChanged', PROPS,
                'org.bluez.obex', path_keyword='path')
            self.obex_ready = True
            emit('status', feature='files', ready=True)
        except dbus.DBusException as e:
            emit('status', feature='files', ready=False, error=e.get_dbus_message() or e.get_dbus_name())

    # -- obex ------------------------------------------------------------

    def transfer_props(self, transfer):
        props = {}
        try:
            props = dict(self.session.get_object('org.bluez.obex', transfer).GetAll(
                'org.bluez.obex.Transfer1', dbus_interface=PROPS))
            session = self.session.get_object('org.bluez.obex', props.get('Session'))
            props['mac'] = str(session.Get('org.bluez.obex.Session1', 'Destination', dbus_interface=PROPS))
        except Exception:
            pass
        return props

    def answer_push(self, request_id, accept, notify=None):
        entry = self.pending.pop(request_id, None)
        if not entry:
            return False
        reply, error, name, transfer = entry
        if accept:
            os.makedirs(RECEIVE_DIR, exist_ok=True)
            path = unique_path(RECEIVE_DIR, name)
            self.transfers.setdefault(transfer, {})['path'] = path
            reply(path)
        else:
            self.transfers.pop(transfer, None)
            error(Canceled('Canceled') if notify == 'canceled' else Rejected('Declined'))
        if notify:
            emit('obex_request_closed', id=request_id, reason=notify)
        return True

    def expire_request(self, request_id):
        if request_id in self.pending:
            self.answer_push(request_id, False, notify='timeout')
        return False

    def _on_transfer_changed(self, interface, changed, invalidated, path=None):
        if interface != 'org.bluez.obex.Transfer1' or path not in self.transfers:
            return
        t = self.transfers[path]
        status = str(changed.get('Status', t.get('status', 'active')))
        t['status'] = status
        if 'Transferred' in changed:
            t['transferred'] = int(changed['Transferred'])
        emit('obex_progress', transfer=path, **{k: v for k, v in t.items() if k != 'session'})
        if status in ('complete', 'error'):
            session = t.get('session')
            self.transfers.pop(path, None)
            if session:
                self._remove_session(session)

    def _remove_session(self, session):
        try:
            client = dbus.Interface(self.session.get_object('org.bluez.obex', '/org/bluez/obex'), 'org.bluez.obex.Client1')
            client.RemoveSession(session, reply_handler=lambda: None, error_handler=lambda e: None)
        except dbus.DBusException:
            pass

    def obex_send(self, job_id, mac, path):
        if not self.obex_ready:
            emit('obex_send_failed', id=job_id, error='File transfer is not set up')
            return
        name = os.path.basename(path)
        size = os.path.getsize(path) if os.path.exists(path) else 0

        def failed(e, session=None):
            emit('obex_send_failed', id=job_id, error=e.get_dbus_message() or e.get_dbus_name())
            if session:
                self._remove_session(session)

        def on_session(session):
            def on_transfer(transfer, props):
                self.transfers[str(transfer)] = {
                    'direction': 'outgoing', 'name': name, 'size': size, 'mac': mac,
                    'session': str(session), 'job': job_id, 'status': 'queued', 'transferred': 0,
                }
                emit('obex_progress', transfer=str(transfer), direction='outgoing', name=name,
                     size=size, mac=mac, job=job_id, status='queued', transferred=0)

            opp = dbus.Interface(self.session.get_object('org.bluez.obex', session), 'org.bluez.obex.ObjectPush1')
            opp.SendFile(path, reply_handler=on_transfer, error_handler=lambda e: failed(e, session))

        client = dbus.Interface(self.session.get_object('org.bluez.obex', '/org/bluez/obex'), 'org.bluez.obex.Client1')
        emit('obex_progress', transfer=f'pending:{job_id}', direction='outgoing', name=name, size=size,
             mac=mac, job=job_id, status='connecting', transferred=0)
        client.CreateSession(mac, {'Target': dbus.String('opp')}, reply_handler=on_session,
                             error_handler=failed, timeout=90)

    def obex_cancel(self, transfer):
        try:
            self.session.get_object('org.bluez.obex', transfer).Cancel(dbus_interface='org.bluez.obex.Transfer1')
        except Exception as e:
            emit('error', message=f'Cancel failed: {e}')

    # -- serial ----------------------------------------------------------

    def device_path(self, mac):
        suffix = 'dev_' + mac.upper().replace(':', '_')
        manager = dbus.Interface(self.system.get_object('org.bluez', '/'), 'org.freedesktop.DBus.ObjectManager')
        for path in manager.GetManagedObjects():
            if str(path).endswith('/' + suffix):
                return path
        return None

    def serial_connect(self, mac):
        path = self.device_path(mac)
        if not path:
            emit('serial_failed', mac=mac, error='Device not found')
            return
        self.connecting.add(mac)

        def failed(e):
            self.connecting.discard(mac)
            emit('serial_failed', mac=mac, error=e.get_dbus_message() or e.get_dbus_name())

        dbus.Interface(self.system.get_object('org.bluez', path), 'org.bluez.Device1').ConnectProfile(
            SPP_UUID, reply_handler=lambda: None, error_handler=failed, timeout=40)

    def serial_disconnect(self, mac):
        link = self.links.get(mac)
        if link:
            link.close('Disconnected')
        path = self.device_path(mac)
        if path:
            dbus.Interface(self.system.get_object('org.bluez', path), 'org.bluez.Device1').DisconnectProfile(
                SPP_UUID, reply_handler=lambda: None, error_handler=lambda e: None)

    # -- stdin -----------------------------------------------------------

    def _on_stdin(self, fd, cond):
        chunk = os.read(fd, 65536)
        if not chunk:
            self.loop.quit()
            return False
        self._buf += chunk
        while b'\n' in self._buf:
            line, self._buf = self._buf.split(b'\n', 1)
            try:
                self.handle(json.loads(line))
            except Exception as e:
                emit('error', message=f'{type(e).__name__}: {e}')
        return True

    def handle(self, msg):
        cmd = msg.get('cmd')
        if cmd == 'serial_connect':
            self.serial_connect(msg['mac'])
        elif cmd == 'serial_disconnect':
            self.serial_disconnect(msg['mac'])
        elif cmd == 'serial_write':
            link = self.links.get(msg['mac'])
            if link:
                link.write(base64.b64decode(msg['data']))
            else:
                emit('serial_failed', mac=msg['mac'], error='Not connected')
        elif cmd == 'obex_send':
            self.obex_send(msg['id'], msg['mac'], msg['path'])
        elif cmd == 'obex_answer':
            if not self.answer_push(msg['id'], bool(msg.get('accept'))):
                emit('obex_request_closed', id=msg['id'], reason='gone')
        elif cmd == 'obex_cancel':
            self.obex_cancel(msg['transfer'])
        elif cmd == 'state':
            emit('state', serial=self.serial_ready, files=self.obex_ready,
                 links=[l.info() for l in self.links.values()])

    def run(self):
        self.system.watch_name_owner('org.bluez', self._on_bluez_owner)
        self.setup_obex()
        GLib.io_add_watch(sys.stdin.fileno(), GLib.IO_IN | GLib.IO_HUP, self._on_stdin)
        emit('ready')
        try:
            self.loop.run()
        finally:
            for link in list(self.links.values()):
                link.close('Helper stopped')


if __name__ == '__main__':
    Helper().run()
