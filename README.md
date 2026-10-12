# 浏览器扩展

自用 Firefox 和 Chrome 扩展。

## Firefox 安装

### 1. 禁用扩展签名校验

进入 `about:config`，搜索 `xpinstall.signatures.required`，将其设置为 `false`。

```js
user_pref("xpinstall.signatures.required", false); // 不校验扩展签名，自定义安装扩展
```

### 2. 安装扩展

- **手动安装**：打开“管理扩展”页面，将扩展拖入安装即可；或点击扩展管理页的设置齿轮按钮，选择“从文件安装附加组件”。
- **在线安装**：在Firefox目录中找到 `.xpi` 扩展，打开后选择 raw 源文件即可在线安装。如果当地网络有问题，可以自行添加 [gh-proxy.com](https://gh-proxy.com) 之类的加速。

## Chrome 安装

1. 下载扩展的整个文件夹(M3U8-AD-Cleaner)，解压后放到非 Chrome 配置的任意文件夹下。
2. 打开浏览器的扩展管理页，开启“开发者模式”。
3. 点击左侧的“加载未打包的扩展程序”，选择刚才的文件夹加载即可。
