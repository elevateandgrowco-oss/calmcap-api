/**
 * CalmCap API — TikTok OAuth + Video Upload backend
 * Handles the server-side secrets so the browser never sees client_secret.
 *
 * Endpoints:
 *   GET  /health
 *   GET  /tiktok/auth-url          → { url, state }
 *   POST /tiktok/exchange          { code } → { access_token, user, ... }
 *   POST /tiktok/upload            multipart: video + access_token + caption + publish
 *   GET  /tiktok/status/:id        ?access_token=... → TikTok status
 */

import express from "express";
import axios from "axios";
import cors from "cors";
import multer from "multer";
import dotenv from "dotenv";
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const CLIENT_KEY    = process.env.TIKTOK_CLIENT_KEY;
const CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET;
const REDIRECT_URI  = process.env.REDIRECT_URI || "https://calmcap.us";

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use(cors({
  origin: (origin, cb) => cb(null, true), // open for TikTok reviewer testing
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));
app.options("*", cors());
app.use(express.json({ limit: "10mb" }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB
});

// ── Health ────────────────────────────────────────────────────────────────────
app.get("/health", (_req, res) =>
  res.json({ ok: true, service: "calmcap-api", ts: Date.now() })
);

// ── GET /tiktok/auth-url ──────────────────────────────────────────────────────
app.get("/tiktok/auth-url", (req, res) => {
  if (!CLIENT_KEY) {
    return res.status(500).json({ error: "TIKTOK_CLIENT_KEY not configured" });
  }
  const state = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const url =
    `https://www.tiktok.com/v2/auth/authorize/` +
    `?client_key=${CLIENT_KEY}` +
    `&scope=user.info.basic,user.info.profile,user.info.stats,video.upload,video.publish` +
    `&response_type=code` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&state=${state}`;
  res.json({ url, state });
});

// ── POST /tiktok/exchange ─────────────────────────────────────────────────────
app.post("/tiktok/exchange", async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: "Missing code" });
  if (!CLIENT_KEY || !CLIENT_SECRET) {
    return res.status(500).json({ error: "TikTok credentials not configured" });
  }

  try {
    const tokenRes = await axios.post(
      "https://open.tiktokapis.com/v2/oauth/token/",
      new URLSearchParams({
        client_key:    CLIENT_KEY,
        client_secret: CLIENT_SECRET,
        code,
        grant_type:    "authorization_code",
        redirect_uri:  REDIRECT_URI,
      }).toString(),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );

    if (tokenRes.data.error) {
      return res.status(400).json({
        error: tokenRes.data.error_description || tokenRes.data.error,
      });
    }

    const { access_token, open_id, refresh_token, expires_in, scope } = tokenRes.data;

    // Fetch user profile (best-effort)
    let user = null;
    try {
      const userRes = await axios.get(
        "https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,avatar_url,username,bio_description,is_verified,follower_count,following_count,likes_count,video_count",
        { headers: { Authorization: `Bearer ${access_token}` } }
      );
      user = userRes.data?.data?.user || null;
    } catch (e) {
      console.warn("User info fetch failed:", e.message);
    }

    res.json({ access_token, open_id, refresh_token, expires_in, scope, user });
  } catch (err) {
    console.error("Exchange error:", err.response?.data || err.message);
    res.status(500).json({
      error: err.response?.data?.error_description || err.message,
    });
  }
});

// ── POST /tiktok/upload ───────────────────────────────────────────────────────
app.post("/tiktok/upload", upload.single("video"), async (req, res) => {
  const { access_token, caption, publish } = req.body;
  const videoBuffer = req.file?.buffer;
  const video_url   = req.body.video_url;

  if (!access_token) return res.status(400).json({ error: "Missing access_token" });
  if (!videoBuffer && !video_url) {
    return res.status(400).json({ error: "Provide a video file or video_url" });
  }

  const privacyLevel = publish === "true" ? "PUBLIC_TO_EVERYONE" : "SELF_ONLY";
  const isFileUpload = !!videoBuffer;

  try {
    const initBody = {
      post_info: {
        title: (caption || "CalmCap product video").slice(0, 150),
        privacy_level: privacyLevel,
        disable_duet: false,
        disable_comment: false,
        disable_stitch: false,
        brand_organic_toggle: true,
      },
      source_info: isFileUpload
        ? {
            source: "FILE_UPLOAD",
            video_size:        videoBuffer.length,
            chunk_size:        videoBuffer.length,
            total_chunk_count: 1,
          }
        : { source: "PULL_FROM_URL", video_url },
    };

    const initRes = await axios.post(
      "https://open.tiktokapis.com/v2/post/publish/video/init/",
      initBody,
      {
        headers: {
          Authorization:   `Bearer ${access_token}`,
          "Content-Type":  "application/json; charset=UTF-8",
        },
      }
    );

    if (initRes.data.error?.code && initRes.data.error.code !== "ok") {
      return res.status(400).json({ error: initRes.data.error });
    }

    const { upload_url, publish_id } = initRes.data.data;

    // Upload the bytes if file
    if (isFileUpload && upload_url) {
      await axios.put(upload_url, videoBuffer, {
        headers: {
          "Content-Type":  "video/mp4",
          "Content-Range": `bytes 0-${videoBuffer.length - 1}/${videoBuffer.length}`,
        },
        maxBodyLength:    Infinity,
        maxContentLength: Infinity,
      });
    }

    res.json({
      publish_id,
      privacy_level: privacyLevel,
      is_draft: privacyLevel === "SELF_ONLY",
      status: "PROCESSING_UPLOAD",
    });
  } catch (err) {
    console.error("Upload error:", err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || { message: err.message } });
  }
});

// ── GET /tiktok/status/:publish_id ────────────────────────────────────────────
app.get("/tiktok/status/:publish_id", async (req, res) => {
  const { access_token } = req.query;
  const { publish_id }   = req.params;
  if (!access_token) return res.status(400).json({ error: "Missing access_token" });

  try {
    const statusRes = await axios.post(
      "https://open.tiktokapis.com/v2/post/publish/status/fetch/",
      { publish_id },
      {
        headers: {
          Authorization:  `Bearer ${access_token}`,
          "Content-Type": "application/json; charset=UTF-8",
        },
      }
    );
    res.json(statusRes.data);
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

app.listen(PORT, () => console.log(`CalmCap API on :${PORT}`));
