"""Pure/injected sysfs/proc statistics; no module, swap or live device changes."""
import copy
import importlib.util
from pathlib import Path
import stat
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('zram_statistics', Path(__file__).parent.parent / 'server/host-zram.py')
z = importlib.util.module_from_spec(spec)
spec.loader.exec_module(z)
HEADER = 'Filename Type Size Used Priority\n'


class ObservedHost(z.HostZram):
    def __init__(self):
        super().__init__('panel', 'local')
        self.observed = {'path': '/dev/zram42', 'enabled': True, 'logicalSizeBytes': 959*z.MIB,
                         'swapUsedBytes': z.MIB, 'originalDataBytes': z.MIB + 4096,
                         'compressedDataBytes': 200*1024, 'residentBytes': 504*1024,
                         'residentLimitBytes': 479*z.MIB, 'algorithm': 'lz4', 'priority': 100}

    def command(self, *args, **kwargs):
        raise AssertionError('No OS command belongs in a statistics fixture')

    def memory(self): return (1919*z.MIB, 700*z.MIB)
    def owner(self): return {'ownerId': 'fixture-owner'}
    def config(self, owner): return {'enabled': True, 'profile': 'auto'}
    def state(self, owner): return {}
    def swaps(self): return {'/dev/zram42': {'size': 959*z.MIB, 'used': self.observed['swapUsedBytes'], 'priority': 100}}
    def device(self, owner, state, swaps): return copy.deepcopy(self.observed)
    def foreign(self, own_device=None): return False
    def swap_kind(self, filename): return 'zram'


class Statistics(unittest.TestCase):
    def test_distinct_kernel_counters_do_not_turn_logical_usage_into_compressed_bytes(self):
        result = z.parse_mm_stat('1052672 204800 516096 502267904 0 0 0 0 0\n')
        self.assertEqual(result, {'originalDataBytes': 1052672, 'compressedDataBytes': 204800,
                                  'residentBytes': 516096, 'residentLimitBytes': 502267904})
        self.assertEqual(result['residentBytes'], 504*1024)
        self.assertGreater(result['residentBytes'], result['compressedDataBytes'])
        observed = z.parse_mm_stat('983040 40178 516096 502267904 516096 0 0 0 0')
        self.assertEqual(observed['originalDataBytes'], 960*1024)
        self.assertEqual(observed['compressedDataBytes'], 40178)
        self.assertEqual(observed['residentBytes'], 504*1024)

    def test_zero_and_same_filled_pages_are_valid_without_an_invented_ratio(self):
        self.assertEqual(z.parse_mm_stat('0 0 0 0')['originalDataBytes'], 0)
        result = z.parse_mm_stat('1048576 0 4096 0 4096 256 0 0 0')
        self.assertEqual(result['compressedDataBytes'], 0)
        self.assertNotIn('compressionRatio', result)
        self.assertNotIn('savedBytes', result)

    def test_allocator_overhead_can_exceed_original_data_without_clamping(self):
        result = z.parse_mm_stat('4096 4000 8192 65536')
        self.assertEqual(result['residentBytes'], 8192)
        self.assertGreater(result['residentBytes'], result['originalDataBytes'])

    def test_malformed_negative_short_or_unsafe_byte_counters_fail_closed(self):
        for text in ['', '1 2 3', '1 2 -3 4', '1 x 3 4', '1 2 3 NaN', '1 2 3 4.5',
                     f'1 2 {z.MAX_SAFE_INTEGER + 1} 4', '1 2 3 4 ' + '0 '*3000]:
            with self.subTest(text=text[:60]), self.assertRaises(z.ZramError): z.parse_mm_stat(text)
        self.assertEqual(z.parse_mm_stat('1 2 3 4 5 6 7 8 9 10')['residentLimitBytes'], 4)

    def test_proc_swap_values_are_kib_bytes_with_signed_priority(self):
        rows = z.parse_swaps(HEADER + '/dev/zram0 partition 982012 1024 100\n/swapfile file 2048 16 -2\n')
        self.assertEqual(rows['/dev/zram0']['used'], z.MIB)
        self.assertEqual(rows['/swapfile'], {'size': 2*z.MIB, 'used': 16384, 'priority': -2})
        self.assertEqual(z.parse_swaps(HEADER), {})

    def test_proc_swap_malformed_duplicate_and_overflow_are_not_silently_counted(self):
        for text in ['', 'Wrong header\n', HEADER + '/a file 1 2 -2\n', HEADER + '/a file -1 0 0\n',
                     HEADER + '/a file 1 0 0\n/a file 1 0 0\n', HEADER + '/a unknown 1 0 0\n',
                     HEADER + f'/a file {z.MAX_SAFE_INTEGER} 0 0\n']:
            with self.subTest(text=text[:60]), self.assertRaises(z.ZramError): z.parse_swaps(text)

    def test_host_totals_include_all_zram_not_just_the_owned_device_and_other_is_not_disk_io(self):
        rows = z.parse_swaps(HEADER + '/dev/zram0 partition 1024 128 100\n/dev/zram1 partition 2048 256 50\n/swapfile file 4096 512 -2\n/missing partition 1024 0 0\n')
        result = z.summarize_swaps(rows, lambda filename: 'zram' if filename.startswith('/dev/zram') else 'other' if filename == '/swapfile' else 'unknown')
        self.assertEqual(result['totalBytes'], 8*z.MIB)
        self.assertEqual(result['zram'], {'totalBytes': 3*z.MIB, 'usedBytes': 384*1024, 'areas': 2})
        self.assertEqual(result['other']['usedBytes'], 512*1024)
        self.assertEqual(result['unknown']['areas'], 1)
        self.assertFalse(result['complete']); self.assertEqual(result['scope'], 'host')
        self.assertNotIn('disk', result)

    def test_kernel_block_identity_supports_alias_and_does_not_trust_a_zram_looking_name(self):
        class Device:
            name = 'zram7'
            def resolve(self, strict=False): return self
        device = Device()
        class Sysfs:
            def __truediv__(self, name):
                self.test.assertEqual(name, '252:7')
                return device
        sysfs = Sysfs(); sysfs.test = self
        info = SimpleNamespace(st_mode=stat.S_IFBLK, st_rdev=123)
        seen = []
        def filename(value):
            seen.append(str(value))
            if str(value) == '/sys/dev/block': return sysfs
            return SimpleNamespace(stat=lambda: info)
        with patch.object(z, 'Path', filename), patch.object(z.os, 'major', lambda _: 252, create=True), patch.object(z.os, 'minor', lambda _: 7, create=True):
            host = z.HostZram('panel', 'local')
            self.assertEqual(host.swap_kind('/dev/disk/by-uuid/fixture'), 'zram')
            device.name = 'vda1'; self.assertEqual(host.swap_kind('/dev/zram-looking'), 'other')
            info.st_mode = stat.S_IFREG; self.assertEqual(host.swap_kind('/swap\\040file'), 'other')
            self.assertIn('/swap file', seen)
        with patch.object(z, 'Path', side_effect=FileNotFoundError): self.assertEqual(host.swap_kind('/gone'), 'unknown')

    def test_usage_and_summary_changes_never_invalidate_a_reviewed_configuration_revision(self):
        original_path = z.Path
        def filename(value):
            return SimpleNamespace(read_text=lambda: 'fixture-boot-id') if str(value) == '/proc/sys/kernel/random/boot_id' else original_path(value)
        with patch.object(z, 'Path', filename), patch.object(z.os, 'geteuid', lambda: 0, create=True):
            host = ObservedHost(); before = host.inspect()
            self.assertRegex(before['observedAt'], r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$')
            host.observed.update(swapUsedBytes=2*z.MIB, originalDataBytes=3*z.MIB, compressedDataBytes=z.MIB, residentBytes=2*z.MIB)
            after = host.inspect(); self.assertEqual(before['revision'], after['revision'])
            self.assertNotEqual(before['effective']['compressedDataBytes'], after['effective']['compressedDataBytes'])
            self.assertNotEqual(before['swapSummary']['usedBytes'], after['swapSummary']['usedBytes'])
            host.observed['algorithm'] = 'zstd'; self.assertNotEqual(after['revision'], host.inspect()['revision'])
            host.observed['algorithm'] = 'lz4'; host.observed['residentLimitBytes'] += z.MIB
            self.assertNotEqual(after['revision'], host.inspect()['revision'])


if __name__ == '__main__': unittest.main(verbosity=2)
