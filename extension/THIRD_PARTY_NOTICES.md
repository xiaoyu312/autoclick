# Third-party notices / 第三方声明

No third-party source tree, installed dependency, binary, font, photo or production fixture is vendored in this source candidate. The extension has no npm dependencies and uses browser APIs.

本源码包未附带第三方源码树、依赖安装目录、二进制、字体、照片或生产样例。扩展使用浏览器 API，没有 npm 依赖。

The desktop lockfile records these direct development/runtime tool dependencies:

| Dependency | Pinned version | License recorded by the local lockfile | Use |
| --- | --- | --- | --- |
| Electron | 43.0.0 | MIT | Embedded Chromium application runtime |
| electron-builder | 26.15.6 | MIT | Optional Windows portable packaging |

Transitive dependency license fields remain unchanged in `desktop/package-lock.json`. They are metadata, not a replacement for each project's license text. Installed artifacts and final binaries may include components under additional licenses; retain the full upstream notices when distributing them. This preparation did not download dependencies, audit their current vulnerabilities or produce binaries.

间接依赖的许可字段保留在锁文件中，不能替代上游许可证原文。安装产物及最终二进制可能包含其他许可的组件，分发时应完整保留上游声明。本次没有下载依赖、审计其最新漏洞或构建程序。

Node.js and Python are user-provided development tools. Generated icons and the two-item demo were authored for this package; they are not adapted from the original icon files or business pages. Technical DOM selectors and the “讲解 / 取消讲解” action labels are compatibility logic, not copied product data or an affiliation claim.
