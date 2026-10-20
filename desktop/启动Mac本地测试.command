#!/bin/zsh

PROJECT_DIR="${0:A:h}"
ELECTRON_BIN="$PROJECT_DIR/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"

pause_before_exit() {
  print ""
  print "按回车退出。"
  read -r REPLY
}

if [[ ! -x "$ELECTRON_BIN" ]]; then
  print "未找到项目内 Electron：$ELECTRON_BIN"
  print "请先在终端执行："
  print "cd \"$PROJECT_DIR\" && npm install"
  pause_before_exit
  exit 1
fi

if ! cd "$PROJECT_DIR"; then
  print "无法进入项目目录：$PROJECT_DIR"
  pause_before_exit
  exit 1
fi

"$ELECTRON_BIN" "$PROJECT_DIR"
EXIT_STATUS=$?
if (( EXIT_STATUS != 0 )); then
  print "Electron 启动失败，退出码：$EXIT_STATUS"
  pause_before_exit
fi
exit "$EXIT_STATUS"
