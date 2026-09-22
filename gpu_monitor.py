"""GPU stats, gathered differently depending on the platform.

Jetson boards have no `nvidia-smi` GPU query support - the only way to read
live GPU load/temp/power is to parse `tegrastats` output. Regular Linux boxes
with a discrete NVIDIA GPU use `nvidia-smi` instead. Boards with neither just
report unavailable.
"""

import re
import shutil
import subprocess
import threading
import time


_GR3D_RE = re.compile(r'GR3D_FREQ (\d+)%')
_GPU_TEMP_RE = re.compile(r'\bgpu@([\d.]+)C')
_POWER_RE = re.compile(r'VDD_(?:CPU_GPU_CV|GPU_SOC) (\d+)mW')


class GpuMonitor:
    def __init__(self):
        self._lock = threading.Lock()
        self._latest: dict = {}
        self._backend = self._detect_backend()
        self._started = False

    @staticmethod
    def _detect_backend() -> str | None:
        if shutil.which('tegrastats'):
            return 'tegrastats'
        if shutil.which('nvidia-smi'):
            return 'nvidia-smi'
        return None

    def start(self):
        if self._started or self._backend is None:
            return
        self._started = True
        if self._backend == 'tegrastats':
            threading.Thread(target=self._run_tegrastats, daemon=True).start()
        elif self._backend == 'nvidia-smi':
            threading.Thread(target=self._run_nvidia_smi_loop, daemon=True).start()

    def _run_tegrastats(self):
        try:
            proc = subprocess.Popen(
                ['stdbuf', '-oL', 'tegrastats', '--interval', '2000'],
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
            )
        except Exception:
            return

        for line in proc.stdout:
            data = {'available': True, 'backend': 'tegrastats'}
            gr3d = _GR3D_RE.search(line)
            temp = _GPU_TEMP_RE.search(line)
            power = _POWER_RE.search(line)
            if gr3d:
                data['gpu_percent'] = float(gr3d.group(1))
            if temp:
                data['gpu_temp'] = float(temp.group(1))
            if power:
                data['gpu_power_mw'] = int(power.group(1))
            with self._lock:
                self._latest = data

    def _run_nvidia_smi_loop(self):
        query = ['nvidia-smi', '--query-gpu=utilization.gpu,temperature.gpu,memory.used,memory.total',
                  '--format=csv,noheader,nounits']
        while True:
            try:
                result = subprocess.run(query, capture_output=True, text=True, timeout=3)
                line = result.stdout.strip().split('\n')[0]
                util, temp, mem_used, mem_total = [p.strip() for p in line.split(',')]
                with self._lock:
                    self._latest = {
                        'available': True,
                        'backend': 'nvidia-smi',
                        'gpu_percent': float(util),
                        'gpu_temp': float(temp),
                        'gpu_mem_used': float(mem_used),
                        'gpu_mem_total': float(mem_total),
                    }
            except Exception:
                pass
            time.sleep(2)

    def get_latest(self) -> dict:
        if self._backend is None:
            return {'available': False}
        with self._lock:
            if self._latest:
                return dict(self._latest)
        return {'available': False, 'backend': self._backend}


gpu_monitor = GpuMonitor()

__all__ = ['gpu_monitor', 'GpuMonitor']
