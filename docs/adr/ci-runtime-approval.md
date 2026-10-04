# CI runtime qualification authority

The runtime policy API saves revisioned policy metadata for an existing approved
source root. Public inputs contain neither executable paths nor a qualification
or readiness assertion. Requesting qualification captures the installed candidate
fingerprint without launching a probe. GET and MCP readback use persisted records
and current HRT metadata and never install, probe or change filesystem settings.

Physical qualification approval is intentionally human-only. The approval route
uses the existing implicit local human boundary and mutation-origin boundary;
HTTP bearer authentication and MCP cannot approve themselves. The immutable
command receipt binds the actual human principal to the exact installed
fingerprint. Operator MCP can save policies, request qualification, run an already
approved qualification and read the persisted original approval, results and
readiness. The approver and running principal are rechecked live.

The original qualification ID is its native operation identity. The main catalog
persists the running command before native entry; a lost result requires the
existing host owner's reconciliation and cannot launch another probe. Unconfirmed
physical closure remains recovery-required and never supplies a qualified policy.
Only actual guarded measurements can become qualified evidence. Profile edits do
not rewrite accepted job policy versions; current revocation and evidence expiry
still deny use of the original version.

The concrete producer uses CI-A's guarded physical qualification through the
existing installed HRT host descriptor, current metadata and native owner. It does
not create a second runtime registry or scheduler. Package installation approval
does not authorize provisioning or mounting the dedicated bounded CI volume.
Root owns physical preparation and full database/authenticated MCP acceptance.
