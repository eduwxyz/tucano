# Remote environment UI

These screenshots show the production renderer captured by the [connection picker UI check](https://github.com/JulioAkaminee/tucano/actions/runs/41615573295) at commit `499cf5299a0c963b0ecb40deb143ac370a1eec3e`.

Profiles, addresses and pairing codes are synthetic test fixtures. The connected badge is an exercised UI state, **not evidence of a live connection to a user's VPS**. Protocol/SSH and service tests run separately; see [validation](remote-validation.md).

## Personal and Work environments

Local remains available beside independently named servers. The selected environment and connection state are visible, with connect/reconnect, rename and forget actions.

![Personal and Work example profiles in the environment picker](images/remote-environments.png)

## Explicit pairing

The form reviews the destination before pairing. SSH uses an existing authorized key and verified host; direct remote URLs require HTTPS. The synthetic pairing code is masked.

![SSH pairing form with destination review and masked demonstration code](images/remote-pairing.png)

## Offline recovery

An unavailable environment remains visible, with reconnect and return-to-Local controls. Specific identity, keychain and HTTPS policy failures provide sanitized recovery guidance.

![Offline example environment with recovery actions](images/remote-offline.png)
