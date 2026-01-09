import time

import paho.mqtt.client as mqtt
from flask import Blueprint, render_template

from auth import is_authenticated


class MQTTManager:
    def __init__(self, socketio_instance):
        self.client = None
        self.socketio = socketio_instance
        self.connected = False
        self.topics = set()
        self.subscriptions = set()

    def connect(self, host='localhost', port=1883, username='', password=''):
        try:
            self.client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)

            self.client.on_connect = self.on_connect
            self.client.on_disconnect = self.on_disconnect
            self.client.on_message = self.on_message
            self.client.on_subscribe = self.on_subscribe
            self.client.on_publish = self.on_publish

            if username:
                self.client.username_pw_set(username, password)

            self.client.connect(host, port, 60)
            self.client.loop_start()

            return True
        except Exception as e:
            self.socketio.emit('mqtt_error', {'error': str(e)}, namespace='/mqtt')
            return False

    def disconnect(self):
        if self.client:
            self.client.disconnect()
            self.client.loop_stop()
            self.client = None
        self.connected = False
        self.topics.clear()
        self.subscriptions.clear()
        self.socketio.emit('mqtt_status', {'connected': False, 'message': 'Disconnected'}, namespace='/mqtt')

    def subscribe(self, topic):
        if self.client and self.connected:
            try:
                self.client.subscribe(topic)
                self.subscriptions.add(topic)
                return True
            except Exception as e:
                self.socketio.emit('mqtt_error', {'error': str(e)}, namespace='/mqtt')
                return False
        return False

    def publish(self, topic, payload, qos=0, retain=False):
        if self.client and self.connected:
            try:
                self.client.publish(topic, payload, qos, retain)
                return True
            except Exception as e:
                self.socketio.emit('mqtt_error', {'error': str(e)}, namespace='/mqtt')
                return False
        return False

    def on_connect(self, client, userdata, flags, reason_code, properties=None):
        if reason_code == 0:
            self.connected = True
            self.socketio.emit('mqtt_status', {'connected': True, 'message': 'Connected'}, namespace='/mqtt')
            client.subscribe('#')
        else:
            self.connected = False
            self.socketio.emit(
                'mqtt_status',
                {'connected': False, 'message': f'Connection failed: {reason_code}'},
                namespace='/mqtt',
            )

    def on_disconnect(self, client, userdata, flags, reason_code, properties=None):
        self.connected = False
        self.socketio.emit('mqtt_status', {'connected': False, 'message': 'Disconnected'}, namespace='/mqtt')

    def on_message(self, client, userdata, msg):
        try:
            topic = msg.topic
            payload = msg.payload.decode('utf-8')

            self.topics.add(topic)

            self.socketio.emit(
                'mqtt_message',
                {
                    'topic': topic,
                    'payload': payload,
                    'qos': msg.qos,
                    'retain': msg.retain,
                    'timestamp': time.time() * 1000,
                },
                namespace='/mqtt',
            )

            self.socketio.emit('mqtt_topics', {'topics': list(self.topics)}, namespace='/mqtt')

        except Exception as e:
            self.socketio.emit('mqtt_error', {'error': f'Message handling error: {str(e)}'}, namespace='/mqtt')

    def on_subscribe(self, client, userdata, mid, reason_code_list, properties=None):
        pass

    def on_publish(self, client, userdata, mid, reason_code, properties=None):
        pass


mqtt_manager = None


def build_mqtt_blueprint() -> Blueprint:
    bp = Blueprint('mqtt', __name__)

    @bp.route('/mqtt_explorer')
    def mqtt_explorer():
        return render_template('mqtt_explorer.html')

    return bp


def register_mqtt_socket_handlers(socketio):
    @socketio.on('connect', namespace='/mqtt')
    def handle_mqtt_connect():
        if not is_authenticated():
            return False

    @socketio.on('disconnect', namespace='/mqtt')
    def handle_mqtt_disconnect():
        pass

    @socketio.on('mqtt_connect', namespace='/mqtt')
    def handle_mqtt_broker_connect(data):
        global mqtt_manager
        if mqtt_manager:
            mqtt_manager.disconnect()

        mqtt_manager = MQTTManager(socketio)

        host = (data or {}).get('host', 'localhost')
        port = (data or {}).get('port', 1883)
        username = (data or {}).get('username', '')
        password = (data or {}).get('password', '')

        success = mqtt_manager.connect(host, port, username, password)
        if not success:
            socketio.emit('mqtt_status', {'connected': False, 'message': 'Connection failed'}, namespace='/mqtt')

    @socketio.on('mqtt_disconnect', namespace='/mqtt')
    def handle_mqtt_broker_disconnect():
        global mqtt_manager
        if mqtt_manager:
            mqtt_manager.disconnect()
            mqtt_manager = None

    @socketio.on('mqtt_subscribe', namespace='/mqtt')
    def handle_mqtt_subscribe(data):
        global mqtt_manager
        if mqtt_manager:
            topic = (data or {}).get('topic', '')
            if topic:
                mqtt_manager.subscribe(topic)

    @socketio.on('mqtt_publish', namespace='/mqtt')
    def handle_mqtt_publish(data):
        global mqtt_manager
        if mqtt_manager:
            topic = (data or {}).get('topic', '')
            payload = (data or {}).get('payload', '')
            qos = (data or {}).get('qos', 0)
            retain = (data or {}).get('retain', False)

            if topic:
                mqtt_manager.publish(topic, payload, qos, retain)


def mqtt_cleanup_on_shutdown():
    global mqtt_manager
    if mqtt_manager:
        mqtt_manager.disconnect()
        mqtt_manager = None


__all__ = ['build_mqtt_blueprint', 'register_mqtt_socket_handlers', 'mqtt_cleanup_on_shutdown']
