"""Read-only macOS process footprint for the listener on a configured port.

ABI: Apple sys/resource.h, rusage_info_v0 (RUSAGE_INFO_V0 = 0).
No signals, service control, model calls or credential access.
"""
import ctypes
import json
import subprocess
import sys


class Usage(ctypes.Structure):
    _fields_ = [('uuid', ctypes.c_uint8 * 16)] + [(name, ctypes.c_uint64) for name in (
        'user_time', 'system_time', 'pkg_idle_wkups', 'interrupt_wkups', 'pageins',
        'wired_size', 'resident_size', 'phys_footprint', 'proc_start_abstime', 'proc_exit_abstime')]


def footprint(pid):
    library = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
    library.proc_pid_rusage.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_void_p]
    library.proc_pid_rusage.restype = ctypes.c_int
    usage = Usage()
    if library.proc_pid_rusage(pid, 0, ctypes.byref(usage)) != 0:
        raise OSError('cannot read process footprint')
    return {'pid': pid, 'footprintBytes': usage.phys_footprint, 'startedAt': usage.proc_start_abstime}


def main():
    if sys.platform != 'darwin':
        raise ValueError('macOS footprint requires Darwin')
    port = int(sys.argv[1])
    if not 0 < port < 65536:
        raise ValueError('invalid port')
    result = subprocess.run([sys.argv[2], '-t', '-nP', f'-iTCP:{port}', '-sTCP:LISTEN'], capture_output=True, text=True, timeout=5, check=True)
    pids = set(result.stdout.split())
    if len(pids) != 1 or not next(iter(pids)).isdigit():
        raise ValueError('expected exactly one listener')
    print(json.dumps(footprint(int(next(iter(pids))))))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('memory release could not be verified', file=sys.stderr)
        sys.exit(1)
