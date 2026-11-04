# -*- coding: utf-8 -*-
Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "WinVer.nsh"
!include "x64.nsh"

Name "Vibez"
OutFile "${OUT_FILE}"
InstallDir "$LOCALAPPDATA\Programs\Vibez"
RequestExecutionLevel user
SetCompressor /SOLID lzma
SetCompressorDictSize 32
BrandingText "Vibez — listen together"
Icon "${APP_DIR}/Vibez.ico"
UninstallIcon "${APP_DIR}/Vibez.ico"
VIProductVersion "${VERSION}.0"
VIAddVersionKey /LANG=1033 "ProductName" "Vibez"
VIAddVersionKey /LANG=1033 "FileDescription" "Vibez desktop setup"
VIAddVersionKey /LANG=1033 "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=1033 "ProductVersion" "${VERSION}"
VIAddVersionKey /LANG=1033 "LegalCopyright" "Vibez contributors"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\Vibez.exe"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Function .onInit
  SetShellVarContext current
  SetRegView 64
  ReadRegStr $0 HKCU "Software\BikeShed\Vibez" "InstallDir"
  ${If} $0 != ""
    StrCpy $INSTDIR $0
  ${EndIf}
  ${IfNot} ${AtLeastWin10}
    MessageBox MB_OK "Vibez requires 64-bit Windows 10 or newer."
    Abort
  ${EndIf}
  ${IfNot} ${RunningX64}
    MessageBox MB_OK "Vibez requires 64-bit Windows."
    Abort
  ${EndIf}
  !if "${APP_ARCH}" == "arm64"
    ${IfNot} ${IsNativeARM64}
      MessageBox MB_OK "This installer is for Windows ARM64. Download the x64 installer for Intel/AMD."
      Abort
    ${EndIf}
  !endif
FunctionEnd

Section "Vibez" SEC_MAIN
  IfFileExists "$INSTDIR\Vibez.exe" 0 +3
    ExecWait '"$INSTDIR\Vibez.exe" --quit'
    Sleep 1000
  SetOutPath "$INSTDIR"
  File /r "${APP_DIR}/*"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateDirectory "$SMPROGRAMS\Vibez"
  CreateShortcut "$SMPROGRAMS\Vibez\Vibez.lnk" "$INSTDIR\Vibez.exe" "" "$INSTDIR\Vibez.ico"
  CreateShortcut "$SMPROGRAMS\Vibez\Uninstall Vibez.lnk" "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\BikeShed\Vibez" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\Classes\vibez" "" "Vibez URL"
  WriteRegStr HKCU "Software\Classes\vibez" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\vibez\DefaultIcon" "" "$INSTDIR\Vibez.ico"
  WriteRegStr HKCU "Software\Classes\vibez\shell\open\command" "" '"$INSTDIR\Vibez.exe" -- "%1"'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Vibez" "DisplayName" "Vibez"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Vibez" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Vibez" "Publisher" "Bike Shed"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Vibez" "DisplayIcon" "$INSTDIR\Vibez.ico"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Vibez" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Vibez" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Vibez" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Vibez" "NoRepair" 1
SectionEnd

Function un.onInit
  SetShellVarContext current
  SetRegView 64
FunctionEnd

Section "Uninstall"
  IfFileExists "$INSTDIR\Vibez.exe" 0 +3
    ExecWait '"$INSTDIR\Vibez.exe" --uninstall-integration'
    Sleep 1000
  ; Fallback if the executable could not run: only remove our own exact handler.
  ReadRegStr $0 HKCU "Software\Classes\vibez\shell\open\command" ""
  ${If} $0 == '"$INSTDIR\Vibez.exe" -- "%1"'
    DeleteRegKey HKCU "Software\Classes\vibez"
  ${EndIf}
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "io.bike-shed.vibez.desktop"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "io.bike-shed.vibez.desktop"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Vibez"
  DeleteRegKey HKCU "Software\BikeShed\Vibez"
  Delete "$SMPROGRAMS\Vibez\Vibez.lnk"
  Delete "$SMPROGRAMS\Vibez\Uninstall Vibez.lnk"
  RMDir "$SMPROGRAMS\Vibez"
  !include "${FILE_MANIFEST}"
  ; Preserve the user's Roaming\Vibez profile and encrypted session.
SectionEnd
