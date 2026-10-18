"""Pure and injected-boundary checks. Never modprobe/swapoff/write host sysfs."""
import importlib.util
import sys
from pathlib import Path
from types import SimpleNamespace
import uuid
from unittest.mock import patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('vortex_zram', Path(__file__).parent.parent / 'server/host-zram.py')
z = importlib.util.module_from_spec(spec)
spec.loader.exec_module(z)

assert z.recommended_size(z.GIB) == {'logicalSizeBytes': 512*z.MIB, 'residentLimitBytes': 256*z.MIB}
assert z.recommended_size(2*z.GIB) == {'logicalSizeBytes': z.GIB, 'residentLimitBytes': 512*z.MIB}
assert z.recommended_size(128*z.GIB) == {'logicalSizeBytes': 2*z.GIB, 'residentLimitBytes': z.GIB}
assert not z.safe_to_disable(1100*z.MIB, z.GIB, 2*z.GIB)
assert z.safe_to_disable(1280*z.MIB, z.GIB, 2*z.GIB)
assert not z.safe_to_disable(512*z.MIB, 0, 16*z.GIB)

request = {'role': 'panel', 'nodeId': 'local', 'enabled': False, 'profile': 'auto', 'confirmed': True,
           'revision': 'a'*64, 'requestId': str(uuid.uuid4())}
for extra in ['force', 'device', 'command', 'size', 'password']:
    try:
        z.validate_request(dict(request, **{extra: True}), True)
        raise AssertionError('unknown key accepted')
    except z.ZramError as error:
        assert error.code == 'ZRAM_INPUT'


class InertHost(z.HostZram):
    def __init__(self, pressure=False, failure=False, foreign=False):
        super().__init__('panel', 'local')
        self.pressure, self.failure, self.external = pressure, failure, foreign
        self.commands, self.saves, self.active = [], [], True
        self.owner_value = {'schema': 1, 'ownerId': str(uuid.uuid4()), 'role': 'panel', 'nodeId': 'local', 'serviceId': z.SERVICES['panel']}
        self.state_value = {'ownerId': self.owner_value['ownerId'], 'device': '/dev/zram42'}
        self.config_value = {'ownerId': self.owner_value['ownerId'], 'enabled': True, 'profile': 'auto'}

    def owner(self):
        return None if self.external else self.owner_value

    def config(self, owner):
        return self.config_value

    def state(self, owner):
        return self.state_value

    def memory(self):
        return (2*z.GIB, 128*z.MIB if self.pressure else 1800*z.MIB)

    def inspect(self):
        return {'available': not self.external, 'reasonCode': 'ZRAM_EXTERNAL' if self.external else None,
                'revision': 'a'*64, 'effective': {'enabled': self.active}, 'configured': {'enabled': True}}

    def verify_unit(self, owner):
        pass

    def swaps(self):
        return {'/dev/zram42': {'used': z.GIB}} if self.active else {}

    def device(self, owner, state, swaps):
        return {'path': '/dev/zram42', 'enabled': self.active, 'swapUsedBytes': z.GIB}

    def command(self, executable, args, timeout=20):
        self.commands.append((executable, args))
        if 'swapoff' in executable and self.failure:
            raise z.ZramError('ZRAM_SYSTEM')
        raise AssertionError('Unexpected privileged command in refusal-only fixture')


with patch.object(z, 'atomic_json', lambda *args: None):
    for host, code in [(InertHost(pressure=True), 'ZRAM_PRESSURE'), (InertHost(failure=True), 'ZRAM_SYSTEM'), (InertHost(foreign=True), 'ZRAM_EXTERNAL')]:
        try:
            host.apply(request, lock_held=True)
            raise AssertionError('refusal did not occur')
        except z.ZramError as error:
            assert error.code == code
        assert host.active
        assert not any('zramctl' in cmd[0] or 'mkswap' in cmd[0] or 'swapon' in cmd[0] for cmd in host.commands)
        if code != 'ZRAM_SYSTEM':
            assert not host.commands
    host = InertHost(pressure=True)
    with patch.object(z, 'UNIT') as unit:
        try:
            host.cleanup_owned(lock_held=True)
            raise AssertionError('unsafe owned uninstall accepted')
        except z.ZramError as error:
            assert error.code == 'ZRAM_PRESSURE'
        unit.unlink.assert_not_called()

    # Reconfirming an active auto profile cannot format/reset/resize the device.
    active = InertHost()
    active.command = lambda executable, args, timeout=20: active.commands.append((executable, args))
    active.apply(dict(request, enabled=True), lock_held=True)
    assert active.commands == [('/usr/bin/systemctl', ['enable', 'vortex-zram.service'])]
    assert active.config_value['enabled'] is True

    # Model successful kernel acknowledgements and assert destructive ordering.
    draining = InertHost()
    sequence = []
    def command(executable, args, timeout=20):
        if executable.endswith('/swapoff'):
            assert args == ['/dev/zram42']
            sequence.append('swapoff')
            draining.active = False
        elif executable.endswith('/zramctl'):
            assert not draining.active
            assert args == ['--reset', '/dev/zram42']
            sequence.append('reset')
        elif executable.endswith('/systemctl'):
            assert args == ['disable', 'vortex-zram.service']
            sequence.append('disable-boot')
        else:
            raise AssertionError('Unexpected host operation')
        return ''
    draining.command = command
    original_path = z.Path
    def kernel_path(value):
        if str(value) == '/sys/class/zram-control/hot_remove':
            def remove(index):
                assert index == '42' and sequence[-1] == 'reset'
                sequence.append('remove-owned-device')
            return SimpleNamespace(write_text=remove)
        return original_path(value)
    with patch.object(z, 'Path', kernel_path):
        draining.apply(request, lock_held=True)
    assert sequence == ['swapoff', 'reset', 'remove-owned-device', 'disable-boot']
    assert draining.config_value['enabled'] is False
    assert 'device' not in draining.state_value

print('helper safety checks passed')
