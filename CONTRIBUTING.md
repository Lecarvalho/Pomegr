# Contributing to Pomegr

Thanks for helping improve Pomegr. Bug reports, reproducible test cases, documentation feedback, and focused design discussions are welcome through the [issue tracker](https://github.com/Lecarvalho/pomegr/issues).

## Before submitting code

Open an issue before investing in a substantial change. This helps confirm that the change fits Pomegr's provider-neutral architecture, privacy boundaries, and read-only product scope.

Pomegr may be offered under both the open-source AGPL and separate commercial terms. To preserve that option, the project will require an appropriate contributor license agreement before merging copyrightable contributions from outside the current copyright holder. The signing process is not yet available, so unsolicited external code contributions cannot currently be merged.

This temporary restriction does not affect anyone's rights to use, modify, or redistribute Pomegr under the AGPL. It only governs what the official project can merge. A standard contributor agreement and signing workflow should be introduced before accepting external code.

## Engineering expectations

Contributions considered in the future must:

- preserve the normalized browser API and keep provider transcript schemas out of React components;
- never expose prompts, responses, commands, tool results, transcripts, credentials, or unsafe MCP arguments;
- keep the monitor read-only and bound to loopback;
- describe deterministic metrics as heuristics rather than AI judgments;
- update documentation when API contracts, metrics, or provider behavior change; and
- pass `npm run build`, `npm test`, and `npm run lint` as applicable.

## Security reports

Do not place credentials, transcripts, prompts, responses, commands, tool output, or other sensitive data in an issue. For a security-sensitive report, contact the maintainer privately through the [GitHub profile](https://github.com/Lecarvalho) before sharing details.
