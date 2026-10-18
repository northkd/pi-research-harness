; Loaded immediately after the pinned electron-builder extraction macros.
; Keep its installer, upgrade, shortcut and uninstaller logic unchanged.
!macroundef extractUsing7za
!macro extractUsing7za FILE
  File /oname=$PLUGINSDIR\pi-research-7za.exe "${PROJECT_DIR}\node_modules\7zip-bin\win\x64\7za.exe"
  DetailPrint "Installing the local workspace..."
  nsExec::ExecToLog '"$PLUGINSDIR\pi-research-7za.exe" x -y -bb0 -bsp0 -o"$INSTDIR" "${FILE}"'
  Pop $R0
  ${If} $R0 != "0"
    SetErrorLevel 2
    MessageBox MB_OK|MB_ICONSTOP "The application files could not be installed (code $R0). Check the installation folder and available disk space, then run Setup again." /SD IDOK
    Quit
  ${EndIf}
  Delete "$PLUGINSDIR\pi-research-7za.exe"
!macroend
