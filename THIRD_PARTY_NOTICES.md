# Third-party notices

:\ARCHITECT\ (Architect) uses the open-source software listed here. Each entry says how it is
used, its license, its copyright line, and the contents of its NOTICE file where it has one. Full
license texts are at the end of this file.

Rules followed (InfinitumCorp/RULES `reports/oss-reuse.md`): permissive licenses only; packages are
added as dependencies or run as separate tools, not copied into this repository; upstream names
are used only for attribution, never as product branding.

How each item reaches a user:

- **Dependency**: installed from npm with Architect.
- **Optional dependency**: installed with Architect when the platform allows it, and only loaded
  when a feature that needs it is turned on.
- **External tool**: not installed or shipped by Architect. A person installs it; Architect runs
  it only if it is found.
- **Design reference**: the idea was studied and reimplemented. No code was copied.
- **Fetched data set**: not installed with Architect and not stored in this repository. A person runs
  the fetch script; Architect reads the files only when `INFINITUM_GEO_ENABLED` is turned on.

---

## @anthropic-ai/sandbox-runtime

- Use: dependency, 0.0.81. OS sandbox for workspace shell commands (`src/sandbox/runtime.ts`).
- Source: https://github.com/anthropic-experimental/sandbox-runtime (npm: `@anthropic-ai/sandbox-runtime`)
- License: Apache License 2.0 (text: [Apache License 2.0](#apache-license-20))
- Copyright 2025 Anthropic
- NOTICE file: none is shipped in the package.
- Not modified.

## openai/codex: `execpolicy` (design reference)

- Use: design reference for the command allow/deny policy (`src/sandbox/execpolicy.ts`). No code,
  rules or tests were copied, no Rust crate is vendored, and the upstream product name is not used.
- Source: https://github.com/openai/codex
- License: Apache License 2.0
- Copyright 2025 OpenAI
- NOTICE file contents:

  ```text
  OpenAI Codex
  Copyright 2025 OpenAI

  This project includes code derived from [Ratatui](https://github.com/ratatui/ratatui), licensed under the MIT license.
  Copyright (c) 2016-2022 Florian Dehau
  Copyright (c) 2023-2025 The Ratatui Developers
  ```

  (Reproduced for attribution. None of that code, Ratatui-derived or otherwise, is in Architect.)

## openai/symphony (design reference)

- Use: design reference for per-run workspaces under a supervisor (`src/supervisor.ts`). No code
  was copied.
- Source: https://github.com/openai/symphony
- License: Apache License 2.0
- Copyright 2025 OpenAI
- NOTICE file contents:

  ```text
  Copyright 2025 OpenAI

  Licensed under the Apache License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License.
  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing, software
  Distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  See the License for the specific language governing permissions and
  Limitations under the License.
  ```

## awslabs/cli-agent-orchestrator (design reference)

- Use: design reference for the run supervisor (session ownership, reclaiming what a crashed run
  left behind). No code was copied.
- Source: https://github.com/awslabs/cli-agent-orchestrator
- License: Apache License 2.0
- NOTICE file contents:

  ```text
  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
  ```

## @playwright/mcp

- Use: optional peer dependency, 0.0.84. Alternative browser backend
  (`src/instruments/playwright-mcp.ts`), used only when `ARCHITECT_BROWSER_BACKEND=playwright-mcp`
  and the package is installed. Driven over stdio; not bundled.
- Source: https://github.com/microsoft/playwright-mcp (npm: `@playwright/mcp`)
- License: Apache License 2.0
- Copyright (c) Microsoft Corporation.
- NOTICE file: none in the package or the repository.
- Not modified.

## microsoft/markitdown

- Use: external tool. `document_to_markdown` (`src/instruments/documents.ts`) runs the
  `markitdown` command when a person has installed it.
- Source: https://github.com/microsoft/markitdown
- License: MIT (text: [MIT: markitdown](#mit-license-microsoftmarkitdown))
- Copyright (c) Microsoft Corporation.
- NOTICE file: none.

## google/osv-scanner

- Use: external tool, run by `safety_scan` and `architect scan` when installed
  (`src/safety/scanners.ts`).
- Source: https://github.com/google/osv-scanner
- License: Apache License 2.0
- Published by Google; the LICENSE file carries no separate copyright line.
- NOTICE file: none.

## awslabs/git-secrets

- Use: external tool, run by `safety_scan` and `architect scan` when installed;
  `architect scan --install-hooks` runs its own `git secrets --install` to add the pre-commit hook.
- Source: https://github.com/awslabs/git-secrets
- License: Apache License 2.0
- NOTICE file contents:

  ```text
  git-secrets
  Copyright 2015 Amazon.com, Inc. or its affiliates. All Rights Reserved.

  bats
  This product bundles bats, which is available under a "MIT" license.
  For details, see test/bats.
  ```

## NVIDIA/SkillSpector

- Use: external tool, run by `safety_scan` and `architect scan` when installed and the project
  contains agent skills, plugins or MCP configs. Runs with `--no-llm`.
- Source: https://github.com/NVIDIA/skillspector
- License: Apache License 2.0
- Copyright 2026 NVIDIA CORPORATION & AFFILIATES
- NOTICE file: none (the project ships its own THIRD_PARTY_NOTICES.md for its dependencies).

## NVIDIA/garak

- Use: external tool, run by `safety_scan` and `architect scan` only when installed and
  `ARCHITECT_GARAK_ARGS` names a model endpoint to probe.
- Source: https://github.com/NVIDIA/garak
- License: Apache License 2.0
- Copyright (c) 2023 Leon Derczynski; Copyright (c) 2023 NVIDIA CORPORATION & AFFILIATES
- NOTICE file: none.

## openai/human-eval (format and method reference)

- Use: design reference for the evals harness (`src/evals/humaneval.ts`): the task format
  (`task_id`, `prompt`, `test`, `entry_point`), the program layout and the unbiased pass@k
  estimator. Reimplemented in TypeScript; no code or data was copied, and the HumanEval dataset
  is not shipped.
- Source: https://github.com/openai/human-eval
- License: MIT (text: [MIT: human-eval](#mit-license-openaihuman-eval))
- Copyright (c) OpenAI (https://openai.com)
- NOTICE file: none.

## openai/simple-evals (method reference)

- Use: design reference for how the eval report presents metrics. No code was copied.
- Source: https://github.com/openai/simple-evals
- License: MIT (text: [MIT: simple-evals](#mit-license-openaisimple-evals))
- Copyright (c) 2024 OpenAI
- NOTICE file: none.

Not used: openai/evals datasets (CC-BY-SA and GFDL). None are included.
Not used: Loyalsoldier and sing-box geo data sets (GPL-3.0). None are fetched or loaded.

## v2fly/geoip (`geoip.dat`)

- Use: fetched data set, release `202611080027`, asset `geoip.dat`. `npm run geo:fetch` downloads it
  into gitignored `data/geo/geoip.dat` after the official `.sha256sum` matches
  `data/geo/geo.lock.json`. Loaded only when `INFINITUM_GEO_ENABLED` is on, to annotate an IP
  address with a country code (`src/geo/`). The bytes are not in this repository and are not modified.
- Source: https://github.com/v2fly/geoip
- Checksum asset: https://github.com/v2fly/geoip/releases/download/202611080027/geoip.dat.sha256sum
- SHA-256: `eedb24b3b9fcba27e06b92c0428dab90d9496083091ae4cf39e11387fd99d0e2`
- License: Creative Commons Attribution-ShareAlike 4.0 International (CC-BY-SA-4.0).
  Text: https://creativecommons.org/licenses/by-sa/4.0/legalcode
  (the v2fly repository LICENSE is that text). ShareAlike applies to the data set when it is shared.
- The v2fly build reads DB-IP Country Lite (https://db-ip.com/db/download/ip-to-country-lite).
  When sharing the data set, also attribute DB-IP: “IP Geolocation by DB-IP” (https://db-ip.com).
- NOTICE file: none in the repository.

## v2fly/domain-list-community (`dlc.dat`, saved as `geosite.dat`)

- Use: fetched data set, release `20261108011013`, asset `dlc.dat`, stored as `geosite.dat`.
  Same fetch script and flag as geoip. Loaded only when `INFINITUM_GEO_ENABLED` is on, to annotate a
  domain with category codes. The bytes are not in this repository and are not modified.
- Source: https://github.com/v2fly/domain-list-community
- Checksum asset: https://github.com/v2fly/domain-list-community/releases/download/20261108011013/dlc.dat.sha256sum
- SHA-256: `dc4192dd1b644a38276ed06136d26e729fa674d25785adb38c87e040e92376b2`
- License: MIT (text: [MIT: domain-list-community](#mit-license-v2flydomain-list-community))
- Copyright (c) 2018-2019 V2Ray
- NOTICE file: none.

---

# License texts

## Apache License 2.0

Applies to every entry above marked Apache License 2.0. Copied from the
`@anthropic-ai/sandbox-runtime` package.

```text
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright 2025 Anthropic

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```

## MIT License (microsoft/markitdown)

```text
MIT License

Copyright (c) Microsoft Corporation.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE

```

## MIT License (openai/human-eval)

```text
The MIT License

Copyright (c) OpenAI (https://openai.com)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## MIT License (openai/simple-evals)

```text
MIT License

Copyright (c) 2024 OpenAI

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## MIT License (v2fly/domain-list-community)

```text
MIT License

Copyright (c) 2018-2019 V2Ray

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
