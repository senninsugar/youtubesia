import express from "express";
import https from "https";
import fetch from "node-fetch";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
const router = express.Router();

const CONFIG_URL =
  "https://raw.githubusercontent.com/siawaseok3/wakame/master/video_config.json";

const YT_DLP_PATH = "./bin/yt-dlp" + (process.platform === "win32" ? ".exe" : "");

// ==================================================
// ユーティリティ・コアロジック (APIとして公開可能)
// ==================================================

export function createError(name, message, status = 500) {
  const err = new Error(message);
  err.name = name;
  err.status = status;
  return err;
}

/**
 * yt-dlpを実行して動画情報を取得するコア関数
 */
export async function fetchVideoInfoViaYtDlp(id) {
  console.log(`[yt-dlp] Fetching info for: ${id} using ${YT_DLP_PATH}`);
  
  const args = [
    "--js-runtimes", "node",
    "-J",
    "--skip-download",
    "--no-progress",
    "--proxy", "http://ytproxy-siawaseok.duckdns.org:3007",
    `https://www.youtube.com/watch?v=${id}`
  ];

  try {
    const { stdout } = await execFileAsync(YT_DLP_PATH, args, { maxBuffer: 10 * 1024 * 1024 });
    return JSON.parse(stdout);
  } catch (err) {
    console.error("[yt-dlp Execution Error]", err);
    throw createError("YtDlpExecutionError", "yt-dlpでの動画情報取得に失敗しました", 500);
  }
}

/**
 * キャッシュを確認し、存在すればType2形式のデータを返す
 */
export async function fetchCachedType2(id) {
  try {
    const cacheRes = await fetch("https://siawaseok.f5.si/api/cache");
    if (!cacheRes.ok) return null;

    const cacheData = await cacheRes.json();
    
    if (cacheData[id]) {
      console.log(`[Cache Hit] Video ID: ${id}`);
      const type2Res = await fetch(`https://siawaseok.duckdns.org/api/stream/${id}/type2`);
      
      if (type2Res.ok) {
        return await type2Res.json();
      }
    }
  } catch (err) {
    console.error(`[Cache Check Error] ${err.message}`);
  }
  return null;
}

/**
 * 設定JSONを取得
 */
export function fetchConfigJson(url = CONFIG_URL) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let data = "";
        if (res.statusCode !== 200) {
          res.resume();
          return reject(createError("ConfigFetchError", `HTTP ${res.statusCode} エラー`));
        }
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try { resolve(JSON.parse(data)); } catch { reject(createError("ConfigParseError", "JSON パースに失敗")); }
        });
      })
      .on("error", () => reject(createError("ConfigFetchError", "リクエスト失敗")));
  });
}

// ==================================================
// Express ミドルウェア / ハンドラ
// ==================================================

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

function validateYouTubeId(req, res, next) {
  const { id } = req.params;
  if (!/^[\w-]{11}$/.test(id)) {
    return next(createError("ValidateYouTubeIdError", "YouTube ID が不正です", 400));
  }
  next();
}

// ==================================================
// ルーティング定義 (既存の挙動を維持)
// ==================================================

// type1
router.get(
  "/:id",
  validateYouTubeId,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const config = await fetchConfigJson();
    const params = config.params || "";
    res.json({ url: `https://www.youtubeeducation.com/embed/${id}${params}` });
  })
);

// Type2
router.get(
  "/:id/type2",
  validateYouTubeId,
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    // 1. キャッシュの確認
    const cachedData = await fetchCachedType2(id);
    if (cachedData) return res.json(cachedData);

    // 2. yt-dlp 実行
    const data = await fetchVideoInfoViaYtDlp(id);

    // 3. 整形ロジック
    const formats = Array.isArray(data.formats) ? data.formats : [];
    const processedFormats = formats.map((f) => {
      const hasVideo = f.vcodec && f.vcodec !== "none";
      const hasAudio = f.acodec && f.acodec !== "none";
      let streamType = "unknown";
      if (hasVideo && hasAudio) streamType = "both";
      else if (hasVideo) streamType = "video only";
      else if (hasAudio) streamType = "audio only";

      return {
        ...f,
        hasVideo,
        hasAudio,
        streamType,
        isM3u8: typeof f.url === "string" && f.url.includes(".m3u8"),
      };
    });

    res.json({ ...data, formats: processedFormats });
  })
);

// ダウンロード用
router.get(
  "/download/:id",
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    const cachedData = await fetchCachedType2(id);
    if (cachedData) return res.json(cachedData);

    const data = await fetchVideoInfoViaYtDlp(id);
    if (!data.formats || !Array.isArray(data.formats)) {
      throw createError("FormatDataError", "formats が欠損しています");
    }

    const result = {
      "audio only": [],
      "video only": [],
      "audio&video": [],
      "m3u8 raw": [],
      "m3u8 proxy": [],
    };

    for (const f of data.formats) {
      if (!f.url) continue;
      const url = f.url.toLowerCase();
      if (url.includes("lang=") && !url.includes("lang=ja")) continue;

      if (url.endsWith(".m3u8")) {
        const m3u8Data = { url: f.url, resolution: f.resolution, vcodec: f.vcodec, acodec: f.acodec };
        result["m3u8 raw"].push(m3u8Data);
        result["m3u8 proxy"].push({
          ...m3u8Data,
          url: `https://proxy-siawaseok.duckdns.org/proxy/m3u8?url=${encodeURIComponent(f.url)}`,
        });
        continue;
      }

      if (f.resolution === "audio only" || f.vcodec === "none") {
        result["audio only"].push(f);
      } else if (f.acodec === "none") {
        result["video only"].push(f);
      } else {
        result["audio&video"].push(f);
      }
    }
    res.json(result);
  })
);

// ==================================================
// 新規追加: JSONファイルをダウンロードさせるルート
// ==================================================
router.get(
  "/export-json/:id",
  validateYouTubeId,
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    // 既存の取得・整形ロジックを再利用してデータを準備
    let finalData;
    const cachedData = await fetchCachedType2(id);
    
    if (cachedData) {
      finalData = cachedData;
    } else {
      const data = await fetchVideoInfoViaYtDlp(id);
      const formats = Array.isArray(data.formats) ? data.formats : [];
      const processedFormats = formats.map((f) => {
        const hasVideo = f.vcodec && f.vcodec !== "none";
        const hasAudio = f.acodec && f.acodec !== "none";
        let streamType = "unknown";
        if (hasVideo && hasAudio) streamType = "both";
        else if (hasVideo) streamType = "video only";
        else if (hasAudio) streamType = "audio only";

        return {
          ...f,
          hasVideo,
          hasAudio,
          streamType,
          isM3u8: typeof f.url === "string" && f.url.includes(".m3u8"),
        };
      });
      finalData = { ...data, formats: processedFormats };
    }

    // JSONとしてブラウザにダウンロードさせるためのヘッダー設定
    const fileName = `video_info_${id}.json`;
    res.setHeader("Content-Disposition", `attachment; filename=${fileName}`);
    res.setHeader("Content-Type", "application/json");
    res.send(JSON.stringify(finalData, null, 2));
  })
);

router.use((err, req, res, next) => {
  console.error("🔥 Error:", err.name, err.message);
  res.status(err.status || 500).json({
    error: err.name,
    message: err.message,
  });
});

export default router;
