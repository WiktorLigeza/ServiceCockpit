import psutil

# Returns a list of usage percentages per core
per_core = psutil.cpu_percent(interval=1, percpu=True)

for i, usage in enumerate(per_core):
    print(f"Core {i}: {usage}%")
