!ifndef PI_RESEARCH_LONG_PATH_REMOVE
!define PI_RESEARCH_LONG_PATH_REMOVE

; NSIS 3.04 preserves the extended path prefix. Its Unicode directory walker
; can then remove the same deep files that the native 7-Zip extractor creates.
!macro ResearchRemoveInstallDirectory
  Push $R0
  SetOutPath "$TEMP"
  StrCpy $R0 "$INSTDIR" 4
  ${If} $R0 == "\\?\"
    StrCpy $R0 "$INSTDIR"
  ${Else}
    StrCpy $R0 "$INSTDIR" 2
    ${If} $R0 == "\\"
      StrCpy $R0 "$INSTDIR" "" 2
      StrCpy $R0 "\\?\UNC\$R0"
    ${Else}
      StrCpy $R0 "\\?\$INSTDIR"
    ${EndIf}
  ${EndIf}
  ClearErrors
  RMDir /r "$R0"
  ${If} ${Errors}
    SetErrorLevel 3
    MessageBox MB_OK|MB_ICONSTOP "Some application files could not be removed. Close Pi Research Harness and its local tasks, then run the uninstaller again." /SD IDOK
    Quit
  ${EndIf}
  Pop $R0
!macroend

!endif
