// ==UserScript==
// @name         Polymas 课程播放辅助
// @namespace    local.polymas.study-helper
// @version      0.3.0
// @description  跨域播放器控制、固定章节顺序、播放结束后下一节
// @match        https://hike-teaching-center.polymas.com/stu-hike/agent-course-full/*
// @match        https://polymas.com/resource/online/preview/*
// @grant        none
// @run-at       document-idle
// @license      MIT
// ==/UserScript==

(() => {
  "use strict";

  const COURSE_ORIGIN = "https://hike-teaching-center.polymas.com";
  const PLAYER_ORIGIN = "https://polymas.com";
  const CHANNEL = "polymas-local-helper-v3";

  function fileId(url) {
    try {
      return new URL(url, location.href).searchParams.get("fileId") || "";
    } catch {
      return "";
    }
  }

  // ==================== 播放器内部 ====================
  if (
    location.origin === PLAYER_ORIGIN &&
    location.pathname.startsWith("/resource/online/preview/")
  ) {
    if (window.parent === window) return;

    let bound = null;
    let lastStatus = "";

    function video() {
      const all = [...document.querySelectorAll("video")];
      const preferred = all.filter(v =>
        v.matches(".media-preview__video")
      );
      const pool = preferred.length ? preferred : all;

      if (pool.length === 1) return pool[0];

      const visible = pool.filter(v => {
        const r = v.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });

      return visible.length === 1 ? visible[0] : null;
    }

    function send(type, extra = {}) {
      window.parent.postMessage({
        channel: CHANNEL,
        type,
        fileId: fileId(location.href),
        ...extra,
      }, COURSE_ORIGIN);
    }

    function report(force = false) {
      const v = video();
      const status = {
        found: Boolean(v),
        count: document.querySelectorAll("video").length,
        paused: v ? v.paused : true,
        ready: v ? v.readyState : 0,
      };
      const text = JSON.stringify(status);

      if (force || text !== lastStatus) {
        lastStatus = text;
        send("status", status);
      }
    }

    function ended() {
      send("ended");
      report(true);
    }

    function scan() {
      const v = video();
      if (v !== bound) {
        bound?.removeEventListener("ended", ended);
        bound = v;
        bound?.addEventListener("ended", ended);
      }
      report();
    }

    window.addEventListener("message", async event => {
      if (
        event.origin !== COURSE_ORIGIN ||
        event.source !== window.parent ||
        event.data?.channel !== CHANNEL
      ) return;

      const { command, targetFile } = event.data;
      if (targetFile !== fileId(location.href)) return;

      if (command === "ping") {
        scan();
        report(true);
        return;
      }

      const v = video();
      if (!v) {
        send("error", { text: "播放器内部尚未找到视频。" });
        return;
      }

      if (command === "pause") {
        v.pause();
        report(true);
      }

      if (command === "play") {
        try {
          await v.play();
          report(true);
        } catch (error) {
          send("error", {
            text: `播放被拒绝：${error.name}，请点击视频画面。`,
          });
        }
      }
    });

    scan();
    setInterval(scan, 1000);
    return;
  }

  // ==================== 课程页 ====================
  if (location.origin !== COURSE_ORIGIN) return;

  const ID = "polymas-helper-v3";
  if (document.getElementById(ID)) return;

  const courseId = location.pathname.match(
    /\/agent-course-full\/([^/]+)/
  )?.[1];

  if (!courseId) return;

  const STORAGE_KEY = `polymas-helper-order-v3:${courseId}`;

  let queue = [];
  let auto = false;
  let switching = null;
  let autoplay = null;
  let endedTimer = null;
  let playerStatus = null;
  let statusFile = "";
  let message = "等待播放器连接";
  let lastFrame = null;
  let lastFrameURL = "";

  try {
    const saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || "[]");
    if (
      Array.isArray(saved) &&
      saved.every(item =>
        typeof item.key === "string" &&
        typeof item.title === "string"
      )
    ) queue = saved;
  } catch {}

  function rows() {
    return [...document.querySelectorAll(".el-tree-node")]
      .map(node => {
        const row = node.querySelector(
          ":scope > .el-tree-node__content"
        );
        const title = row?.querySelector(".file-name");
        const leaf = row?.querySelector(
          ".el-tree-node__expand-icon.is-leaf"
        );
        const key = node.getAttribute("data-key");

        if (!title || !leaf || !key) return null;

        return {
          key,
          title: title.textContent.trim(),
          target: title,
          current: node.classList.contains("is-current"),
        };
      })
      .filter(Boolean);
  }

  function current() {
    const selected = rows().filter(item => item.current);
    return selected.length === 1 ? selected[0] : null;
  }

  function remember() {
    const seen = new Set();
    queue = rows()
      .filter(item => {
        if (seen.has(item.key)) return false;
        seen.add(item.key);
        return true;
      })
      .map(({ key, title }) => ({ key, title }));

    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(queue));
    } catch {}

    say(`已记录当前列表顺序，共 ${queue.length} 项。`);
  }

  function frame() {
    const f = document.getElementById("previewIframe");
    if (!f) return null;

    try {
      const url = new URL(f.src);
      return url.origin === PLAYER_ORIGIN &&
        url.pathname.startsWith("/resource/online/preview/")
        ? f : null;
    } catch {
      return null;
    }
  }

  function command(commandName) {
    const f = frame();
    const targetFile = f ? fileId(f.src) : "";
    if (!f?.contentWindow || !targetFile) return false;

    f.contentWindow.postMessage({
      channel: CHANNEL,
      command: commandName,
      targetFile,
    }, PLAYER_ORIGIN);

    return true;
  }

  function clearEnded() {
    clearTimeout(endedTimer);
    endedTimer = null;
  }

  function say(text) {
    message = text;
    render();
  }

  function next(automatic = false) {
    if (switching) {
      say("正在等待章节切换。");
      return;
    }

    const selected = current();
    if (!selected) {
      say("无法唯一识别当前章节。");
      return;
    }

    if (!queue.length) remember();

    const index = queue.findIndex(item => item.key === selected.key);
    if (index < 0) {
      auto = false;
      say("当前章节不在固定顺序中，请点击“重记顺序”。");
      return;
    }

    const target = queue[index + 1];
    if (!target) {
      auto = false;
      say("已到固定章节顺序末尾。");
      return;
    }

    if (
      automatic &&
      !/\.(mp4|webm|m4v|mov|ogv)\s*$/i.test(target.title)
    ) {
      auto = false;
      say(`下一项请手动处理：${target.title}`);
      return;
    }

    const matches = rows().filter(item => item.key === target.key);
    if (matches.length !== 1) {
      auto = false;
      say("目标章节未加载或标识重复，请手动处理。");
      return;
    }

    clearEnded();

    const f = frame();
    switching = {
      from: selected.key,
      to: target.key,
      oldFile: f ? fileId(f.src) : "",
      deadline: Date.now() + 10000,
    };

    autoplay = automatic ? {
      key: target.key,
      oldFile: switching.oldFile,
      deadline: Date.now() + 20000,
    } : null;

    say(`正在打开：${target.title}`);
    matches[0].target.click();
  }

  const panel = document.createElement("div");
  panel.id = ID;
  panel.style.cssText =
    "position:fixed;right:16px;bottom:20px;z-index:2147483647";

  const root = panel.attachShadow({ mode: "open" });
  root.innerHTML = `
    <style>
      .box {
        width:295px;padding:14px;background:#fff;color:#243247;
        border:1px solid #d8e0eb;border-radius:12px;
        box-shadow:0 5px 24px #0002;
        font:13px/1.6 system-ui,"Microsoft YaHei",sans-serif;
      }
      .head,.buttons {display:flex;gap:6px;align-items:center}
      .head {justify-content:space-between}
      .buttons {margin:10px 0;flex-wrap:wrap}
      button {
        padding:5px 8px;border:1px solid #ccd5e0;border-radius:6px;
        background:#f5f8fc;color:#243247;cursor:pointer;
      }
      #title,#status,#info {margin-top:8px;overflow-wrap:anywhere}
      #info {color:#63748b;font-size:12px}
      label {display:flex;align-items:center;gap:5px}
    </style>
    <div class="box">
      <div class="head">
        <strong>Polymas 播放辅助 0.3</strong>
        <button id="fold">收起</button>
      </div>
      <div id="body">
        <div id="title"></div>
        <div class="buttons">
          <button id="play">播放</button>
          <button id="pause">暂停</button>
          <button id="next">下一节</button>
          <button id="order">重记顺序</button>
        </div>
        <label>
          <input id="auto" type="checkbox">
          正常结束后自动下一节
        </label>
        <div id="status"></div>
        <div id="info"></div>
      </div>
    </div>
  `;

  function setText(id, text) {
    const el = root.getElementById(id);
    if (el.textContent !== text) el.textContent = text;
  }

  function render() {
    const selected = current();
    const f = frame();
    const connected = Boolean(
      f && playerStatus && statusFile === fileId(f.src)
    );

    setText("title", selected
      ? `当前：${selected.title}`
      : "请打开具体视频。");

    setText("status", message);
    setText("info",
      `固定顺序：${queue.length} 项；` +
      (connected
        ? `播放器已连接；视频节点 ${playerStatus.count}；` +
          (playerStatus.paused ? "暂停" : "播放中")
        : "等待播放器连接")
    );

    root.getElementById("auto").checked = auto;
  }

  window.addEventListener("message", event => {
    const f = frame();

    if (
      !f ||
      event.origin !== PLAYER_ORIGIN ||
      event.source !== f.contentWindow ||
      event.data?.channel !== CHANNEL ||
      event.data.fileId !== fileId(f.src)
    ) return;

    const data = event.data;

    if (data.type === "status") {
      playerStatus = data;
      statusFile = data.fileId;
      render();
    }

    if (data.type === "error") {
      autoplay = null;
      say(data.text);
    }

    if (data.type === "ended" && auto && !switching) {
      const key = current()?.key;
      const resource = data.fileId;
      if (!key) return;

      clearEnded();
      say("视频结束，3 秒后切换下一节。");

      endedTimer = setTimeout(() => {
        endedTimer = null;
        const activeFrame = frame();

        if (
          auto &&
          current()?.key === key &&
          activeFrame &&
          fileId(activeFrame.src) === resource
        ) next(true);
      }, 3000);
    }
  });

  root.getElementById("play").onclick = () => {
    if (command("play")) say("已发送播放指令。");
    else say("尚未找到播放器 iframe。");
  };

  root.getElementById("pause").onclick = () => {
    auto = false;
    autoplay = null;
    clearEnded();
    command("pause");
    say("已发送暂停指令，连续播放已关闭。");
  };

  root.getElementById("next").onclick = () => next(false);

  root.getElementById("order").onclick = () => {
    switching = null;
    autoplay = null;
    clearEnded();
    remember();
  };

  root.getElementById("auto").onchange = event => {
    auto = event.target.checked;
    if (!auto) {
      clearEnded();
      autoplay = null;
    }
    say(auto ? "连续播放已开启。" : "连续播放已关闭。");
  };

  root.getElementById("fold").onclick = event => {
    const body = root.getElementById("body");
    body.hidden = !body.hidden;
    event.target.textContent = body.hidden ? "展开" : "收起";
  };

  function tick() {
    if (!panel.isConnected) document.body?.append(panel);

    if (!queue.length && rows().length) remember();

    const f = frame();
    const frameURL = f?.src || "";

    if (f !== lastFrame || frameURL !== lastFrameURL) {
      clearEnded();
      playerStatus = null;
      statusFile = "";
      lastFrame = f;
      lastFrameURL = frameURL;
    }

    command("ping");

    if (switching) {
      const selected = current();

      if (selected?.key === switching.to) {
        switching = null;
        say("章节已切换。");
      } else if (
        selected?.key &&
        selected.key !== switching.from
      ) {
        switching = null;
        autoplay = null;
        say("检测到手动切换，已取消等待。");
      } else if (Date.now() > switching.deadline) {
        switching = null;
        autoplay = null;
        auto = false;
        say("切换未确认，按钮已解锁。");
      }
    }

    if (autoplay) {
      const resource = f ? fileId(f.src) : "";

      if (Date.now() > autoplay.deadline) {
        autoplay = null;
        say("新播放器未就绪，请手动点击播放。");
      } else if (
        auto &&
        !switching &&
        current()?.key === autoplay.key &&
        resource &&
        resource !== autoplay.oldFile &&
        statusFile === resource &&
        playerStatus?.found &&
        playerStatus.ready >= 2
      ) {
        autoplay = null;
        command("play");
      }
    }

    render();
  }

  document.body.append(panel);
  tick();
  setInterval(tick, 1000);
})();