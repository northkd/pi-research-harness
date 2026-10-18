# 7-Zip installer helper: notices and corresponding source

The Windows installer uses the unmodified standalone `7za.exe` from
`7zip-bin` 5.2.0 (`win/x64/7za.exe`). The binary is byte-for-byte identical
to `x64/7za.exe` in the official 7-Zip 21.07 Extra release.

- 7-Zip version: **21.07**, source version date **2021-12-26**.
- Author and copyright notice: **Copyright (C) 1999-2021 Igor Pavlov.**
- Standalone binary license: **GNU LGPL version 2.1 or, at your option, any later version**.
- Binary size: **1,231,360 bytes**.
- Binary SHA256: `b0cfdeaf429f5cc53f85123dd8f5a5feb92c19d31aa34df257edf9a26be05f95`.
- No changes to the upstream 7-Zip binary or source are made by this project.

`7zip-extra-21.07-LICENSE.txt` is the complete `License.txt` from the
matching official Extra archive. `LGPL-2.1.txt` is the complete
`DOC/copying.txt` from the matching official source archive. These text files
retain their upstream content, with CRLF line endings normalized to LF.
`7zip-bin-MIT.txt` separately preserves the MIT notice of the npm binary
wrapper; that notice does not replace the 7-Zip executable's LGPL license.

## Official release and source locations

Release directory (maintained by 7-Zip author Igor Pavlov):
https://sourceforge.net/projects/sevenzip/files/7-Zip/21.07/

Corresponding source archive:
https://sourceforge.net/projects/sevenzip/files/7-Zip/21.07/7z2107-src.7z/download

Direct official mirror used to retrieve the source:
https://netix.dl.sourceforge.net/project/sevenzip/7-Zip/21.07/7z2107-src.7z

- Source archive filename: `7z2107-src.7z`.
- Source archive size: **1,219,373 bytes**.
- Source archive SHA256: `d1074d56f415aab99d99e597a7b66dc455dba6349ae8a4c89df76475b6a1284c`.
- The checksum matches the SHA256 published on the official SourceForge download page.
- The included `C/7zVersion.h` declares version `21.07` and date `2021-12-26`.

Matching official binary archive:
https://sourceforge.net/projects/sevenzip/files/7-Zip/21.07/7z2107-extra.7z/download

Direct official mirror used to retrieve the binary archive:
https://netix.dl.sourceforge.net/project/sevenzip/7-Zip/21.07/7z2107-extra.7z

- Extra archive size: **994,295 bytes**.
- Extra archive SHA256: `362411800adf3af0170c1cd443120f072774b784f21ecf9edb5843645c53c94b`.

The old `https://www.7-zip.org/a/7z2107-src.7z` URL returned HTTP 404 when
checked on 2026-10-18. The versioned official SourceForge release above
was used instead. A current 7-Zip license was not substituted for the
license shipped with version 21.07.
