from pynvml import *

nvmlInit()
h = nvmlDeviceGetHandleByIndex(0)

mem = nvmlDeviceGetMemoryInfo(h)
print(f"VRAM used: {mem.used / 1024**2:.0f} MB")
