import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cases = [
  ['Public IP needs independent HTTPS-source agreement and a global IPv4', 'discovery_agreement_and_invalid_values'],
  ['An unknown web listener prevents access provisioning before mutation', 'unknown_web_listener_prevents_mutation'],
  ['An IP-detection redirect is rejected before its destination is contacted', 'ip_redirect_is_rejected_before_destination_request'],
  ['Existing custom nginx sites and config remain unchanged', 'unknown_nginx_site_or_config_is_preserved'],
  ['A fresh setup checks the current panel PID over certificate-verified TLS', 'valid_install_verifies_tls_and_current_pid'],
  ['A TLS failure restores environment, own files and own firewall rules', 'tls_failure_rolls_back_only_owned_changes'],
  ['A different health responder PID never completes installation', 'wrong_health_pid_never_passes'],
  ['An invalid nginx candidate restores files before restarting the panel', 'nginx_invalid_configuration_restores_files'],
  ['A failed certificate command cleans its partial private-key output', 'partial_certificate_failure_cleans_own_key'],
  ['An already existing matching firewall rule is preserved on rollback', 'existing_firewall_rule_is_never_deleted'],
  ['An inactive firewall is never enabled or otherwise changed', 'disabled_firewall_remains_disabled'],
  ['An uninspectable installed firewall stops instead of claiming success', 'uninspectable_firewall_never_reports_success'],
  ['A firewall command that fails after mutation rolls back its owned rule', 'ufw_failure_after_mutation_rolls_back_owned_rule'],
  ['An uncertain firewall mutation is retained safely and explicitly needs recovery', 'uncertain_firewall_outcome_requires_manual_recovery'],
  ['Existing extended and application HTTP firewall rules keep their comments', 'existing_complex_firewall_rules_keep_their_comments'],
  ['A failed exclusive write cannot leave a partial nginx candidate behind', 'partial_exclusive_write_does_not_leave_candidate_config'],
  ['Partial-write recovery preserves concurrent edits to the same inode', 'partial_write_never_removes_concurrently_changed_bytes'],
  ['The actual generated certificate validates IP SAN over an in-memory TLS handshake', 'actual_generated_certificate_passes_ip_tls_verification'],
  ['Concurrent administrator edits are preserved and require recovery review', 'concurrent_administrator_file_edit_is_preserved'],
  ['Expired plans and nginx changes between phases stop before mutation', 'plan_expiry_and_changed_baseline_prevent_mutation'],
  ['A public environment cannot accidentally be reconfigured as fresh', 'existing_public_environment_is_not_reconfigured'],
];

for (const [description, name] of cases) {
  test(description, () => {
    const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3', [
      '-B', fileURLToPath(new URL('./public-access-fixture.py', import.meta.url)),
      fileURLToPath(new URL('../deploy/configure-access.py', import.meta.url)), `AccessTests.test_${name}`,
    ], { encoding: 'utf8', timeout: 20000, windowsHide: true });
    assert.equal(result.status, 0, (result.stdout || '') + (result.stderr || '') + (result.error?.message || ''));
    assert.match(result.stderr, /Ran 1 test/);
  });
}
