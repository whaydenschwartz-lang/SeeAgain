/*
================================================================================
  SEEAGAIN SERVER — SAFE STRIPE PAYMENTS WITH MANUAL CAPTURE
================================================================================

REQUIRED ENV VARS:
  - STRIPE_SECRET_KEY        : Your Stripe secret key (sk_live_... or sk_test_...)
  - STRIPE_WEBHOOK_SECRET    : Webhook signing secret from Stripe dashboard (whsec_...)
  - GEMINI_API_KEY           : Google Gemini API key for prompt suggestions
  - AIML_API_KEY             : AI/ML API key for Kling video generation
  - PORT                     : (optional) Server port, defaults to 3000

HOW TO TEST WITH STRIPE CLI:
  1. Install Stripe CLI: https://stripe.com/docs/stripe-cli
  2. Login: stripe login
  3. Forward webhooks locally:
       stripe listen --forward-to localhost:3000/stripe/webhook
  4. Copy the webhook signing secret shown and set it as STRIPE_WEBHOOK_SECRET
  5. Test checkout flow:
       stripe trigger checkout.session.completed

PAYMENT FLOW (Authorize-then-Capture):
  1. User clicks "Animate Photo" → if payment required, creates Checkout Session
     with capture_method: "manual" and jobId in metadata
  2. Stripe checkout completes → webhook "checkout.session.completed" fires
     → server records paymentIntentId with jobId, status = "authorized"
  3. Animation job runs (Kling API call in /animate_photo)
  4. On success: capture PaymentIntent → user is charged
  5. On failure: cancel PaymentIntent → hold is released, no charge

STORAGE:
  - payments.json: Persists jobId -> { paymentIntentId, sessionId, status, createdAt }
  - Survives server restarts
  - Status flow: authorized -> captured | canceled | capture_failed | cancel_failed

SAFETY TIMEOUT:
  - Every 30 minutes, cancels any "authorized" payments older than 2 hours
  - Prevents stuck holds if animation never completes

================================================================================
*/

import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import cors from "cors";
import dotenv from "dotenv";
import formData from "express-form-data";
import Stripe from "stripe";
import fs from "fs";
import ffmpegPath from "ffmpeg-static";
import { spawn } from "child_process";

dotenv.config();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const app = express();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const AIML_API_KEY = process.env.AIML_API_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

if (!GEMINI_API_KEY) {
  console.warn('⚠️ Missing GEMINI_API_KEY');
}
if (!AIML_API_KEY) {
  console.warn('⚠️ Missing AIML_API_KEY');
}
if (!STRIPE_WEBHOOK_SECRET) {
  console.warn('⚠️ Missing STRIPE_WEBHOOK_SECRET - webhooks will not be verified');
}

// ==============================================================================
// PERSISTENT PAYMENT STORAGE (survives restarts)
// ==============================================================================

const PAYMENTS_FILE = path.join(__dirname, "payments.json");

// In-memory cache, synced to disk
let paymentsStore = {};

function loadPayments() {
  try {
    if (fs.existsSync(PAYMENTS_FILE)) {
      const data = fs.readFileSync(PAYMENTS_FILE, "utf-8");
      paymentsStore = JSON.parse(data);
      console.log(`📁 Loaded ${Object.keys(paymentsStore).length} payment records from payments.json`);
    }
  } catch (err) {
    console.error("⚠️ Failed to load payments.json:", err.message);
    paymentsStore = {};
  }
}

function savePayments() {
  try {
    fs.writeFileSync(PAYMENTS_FILE, JSON.stringify(paymentsStore, null, 2));
  } catch (err) {
    console.error("⚠️ Failed to save payments.json:", err.message);
  }
}

// Record a new payment authorization
function recordPayment(jobId, paymentIntentId, sessionId) {
  if (!jobId) return;
  
  // Check if already exists (idempotency for duplicate webhooks)
  if (paymentsStore[jobId]) {
    console.log(`📝 Payment already recorded for jobId: ${jobId}`);
    return paymentsStore[jobId];
  }
  
  const record = {
    paymentIntentId,
    sessionId,
    status: "authorized",
    createdAt: Date.now()
  };
  
  paymentsStore[jobId] = record;
  savePayments();
  
  console.log(`📝 Recorded payment: jobId=${jobId}, piId=${paymentIntentId}, status=authorized`);
  return record;
}

// Update job status
function markJobStatus(jobId, status) {
  if (!jobId || !paymentsStore[jobId]) return null;
  
  const record = paymentsStore[jobId];
  const oldStatus = record.status;
  record.status = status;
  record.updatedAt = Date.now();
  savePayments();
  
  console.log(`📝 Status update: jobId=${jobId}, ${oldStatus} -> ${status}`);
  return record;
}

// Get payment record
function getPayment(jobId) {
  return paymentsStore[jobId] || null;
}

// Check if a job has pending render status stored (for race condition handling)
function getPendingJobStatus(jobId) {
  const record = paymentsStore[jobId];
  if (!record) return null;
  
  // If job completed before webhook arrived
  if (record.status === "render_succeeded" || record.status === "render_failed") {
    return record.status;
  }
  return null;
}

// Store job completion status (for race condition: job finishes before webhook)
function recordJobCompletion(jobId, renderStatus) {
  if (!paymentsStore[jobId]) {
    // Job finished before webhook - create placeholder
    paymentsStore[jobId] = {
      paymentIntentId: null,
      sessionId: null,
      status: renderStatus,
      createdAt: Date.now()
    };
    savePayments();
    console.log(`📝 Job completion recorded (before webhook): jobId=${jobId}, status=${renderStatus}`);
    return paymentsStore[jobId];
  }
  
  // Normal case: webhook already arrived
  return markJobStatus(jobId, renderStatus);
}

// Load payments on startup
loadPayments();

// ==============================================================================
// STRIPE CAPTURE / CANCEL LOGIC
// ==============================================================================

async function capturePayment(jobId) {
  const record = getPayment(jobId);
  if (!record || !record.paymentIntentId) {
    console.log(`⚠️ Cannot capture: no paymentIntentId for jobId=${jobId}`);
    return false;
  }
  
  // Idempotency check
  if (record.status === "captured") {
    console.log(`✅ Already captured: jobId=${jobId}`);
    return true;
  }
  
  if (record.status !== "authorized" && record.status !== "render_succeeded") {
    console.log(`⚠️ Cannot capture: invalid status=${record.status} for jobId=${jobId}`);
    return false;
  }
  
  try {
    console.log(`💳 Capturing payment: jobId=${jobId}, piId=${record.paymentIntentId}`);
    await stripe.paymentIntents.capture(record.paymentIntentId);
    markJobStatus(jobId, "captured");
    console.log(`✅ Payment captured successfully: jobId=${jobId}`);
    return true;
  } catch (err) {
    console.error(`❌ Capture failed for jobId=${jobId}:`, err.message);
    markJobStatus(jobId, "capture_failed");
    return false;
  }
}

async function cancelPayment(jobId) {
  const record = getPayment(jobId);
  if (!record || !record.paymentIntentId) {
    console.log(`⚠️ Cannot cancel: no paymentIntentId for jobId=${jobId}`);
    return false;
  }
  
  // Idempotency check
  if (record.status === "canceled") {
    console.log(`✅ Already canceled: jobId=${jobId}`);
    return true;
  }
  
  if (record.status !== "authorized" && record.status !== "render_failed") {
    console.log(`⚠️ Cannot cancel: invalid status=${record.status} for jobId=${jobId}`);
    return false;
  }
  
  try {
    console.log(`🚫 Canceling payment: jobId=${jobId}, piId=${record.paymentIntentId}`);
    await stripe.paymentIntents.cancel(record.paymentIntentId);
    markJobStatus(jobId, "canceled");
    console.log(`✅ Payment canceled (hold released): jobId=${jobId}`);
    return true;
  } catch (err) {
    console.error(`❌ Cancel failed for jobId=${jobId}:`, err.message);
    markJobStatus(jobId, "cancel_failed");
    return false;
  }
}

// Handle job completion - captures or cancels based on render result
async function handleJobCompletion(jobId, success) {
  const renderStatus = success ? "render_succeeded" : "render_failed";
  
  const record = getPayment(jobId);
  
  if (!record || !record.paymentIntentId) {
    // Webhook hasn't arrived yet - store the completion status
    // It will be processed when webhook arrives
    recordJobCompletion(jobId, renderStatus);
    console.log(`⏳ Job completed before webhook: jobId=${jobId}, status=${renderStatus}`);
    return;
  }
  
  // Update status and capture/cancel
  markJobStatus(jobId, renderStatus);
  
  if (success) {
    await capturePayment(jobId);
  } else {
    await cancelPayment(jobId);
  }
}

// ==============================================================================
// STRIPE WEBHOOK ENDPOINT - MUST BE BEFORE express.json() MIDDLEWARE
// ==============================================================================

app.post("/stripe/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  
  let event;
  
  try {
    if (STRIPE_WEBHOOK_SECRET) {
      event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
    } else {
      // Fallback for development without webhook secret
      event = JSON.parse(req.body.toString());
      console.warn("⚠️ Webhook signature not verified (STRIPE_WEBHOOK_SECRET not set)");
    }
  } catch (err) {
    console.error("❌ Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  
  console.log(`📨 Stripe webhook received: ${event.type}`);
  
  // Handle the event
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;
      const jobId = session.metadata?.jobId;
      const paymentIntentId = session.payment_intent;
      
      console.log(`💰 Checkout completed: sessionId=${session.id}, jobId=${jobId}, piId=${paymentIntentId}`);
      
      if (jobId && paymentIntentId) {
        // Check if job already completed before webhook arrived (race condition)
        const pendingStatus = getPendingJobStatus(jobId);
        
        if (pendingStatus) {
          // Job finished before webhook - update with payment info and process
          paymentsStore[jobId].paymentIntentId = paymentIntentId;
          paymentsStore[jobId].sessionId = session.id;
          savePayments();
          
          console.log(`🔄 Processing delayed job completion: jobId=${jobId}, status=${pendingStatus}`);
          
          if (pendingStatus === "render_succeeded") {
            await capturePayment(jobId);
          } else if (pendingStatus === "render_failed") {
            await cancelPayment(jobId);
          }
        } else {
          // Normal flow: record the payment authorization
          recordPayment(jobId, paymentIntentId, session.id);
        }
      } else {
        console.warn("⚠️ Checkout completed but missing jobId or paymentIntentId");
      }
      break;
    }
    
    case "checkout.session.async_payment_succeeded": {
      const session = event.data.object;
      console.log(`📨 Async payment succeeded: sessionId=${session.id}`);
      // Handle async payment methods (bank transfers, etc.) if needed
      break;
    }
    
    case "checkout.session.async_payment_failed": {
      const session = event.data.object;
      const jobId = session.metadata?.jobId;
      console.log(`❌ Async payment failed: sessionId=${session.id}, jobId=${jobId}`);
      if (jobId) {
        markJobStatus(jobId, "payment_failed");
      }
      break;
    }
    
    default:
      console.log(`📨 Unhandled webhook event: ${event.type}`);
  }
  
  // Respond quickly to acknowledge receipt
  res.status(200).json({ received: true });
});

// ==============================================================================
// MIDDLEWARE (after webhook endpoint)
// ==============================================================================

app.use(cors());
app.use(formData.parse());
app.use(express.json({ limit: '20mb' }));

// Serve static files with caching for videos
app.use(express.static(path.join(__dirname, "public"), {
  maxAge: "1d",  // Cache static assets for 1 day
  setHeaders: (res, filePath) => {
    // Extra long cache for gallery videos (they never change)
    if (filePath.includes("/gallery/") && filePath.endsWith(".mp4")) {
      res.setHeader("Cache-Control", "public, max-age=604800"); // 7 days
    }
    // Shorter cache for generated outputs (user might regenerate)
    if (filePath.includes("/outputs/") && filePath.endsWith(".mp4")) {
      res.setHeader("Cache-Control", "public, max-age=3600"); // 1 hour
    }
  }
}));

// ---- STREAMING DOWNLOAD ROUTE (for iOS Save to Photos) ----
app.get("/api/download/:filename", (req, res) => {
  try {
    // Sanitize filename to prevent path traversal
    const filename = path.basename(req.params.filename);
    
    // Only allow .mp4 files from outputs directory
    if (!filename.endsWith(".mp4")) {
      return res.status(400).send("Invalid file type");
    }
    
    const filePath = path.join(__dirname, "public", "outputs", filename);
    
    // Check file exists
    if (!fs.existsSync(filePath)) {
      return res.status(404).send("File not found");
    }
    
    const stat = fs.statSync(filePath);
    
    // Set headers for download
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Length", stat.size);
    res.setHeader("Content-Disposition", `attachment; filename="SeeAgain-animation.mp4"`);
    res.setHeader("Cache-Control", "no-cache");
    
    // Stream the file (memory efficient)
    const readStream = fs.createReadStream(filePath);
    readStream.pipe(res);
    
    readStream.on("error", (err) => {
      console.error("Stream error:", err);
      if (!res.headersSent) {
        res.status(500).send("Error streaming file");
      }
    });
  } catch (err) {
    console.error("Download route error:", err);
    res.status(500).send("Download failed");
  }
});

// ---- WATERMARK HELPERS ----
function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

async function downloadToFile(url, outPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download video: ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.promises.writeFile(outPath, buf);
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    p.stderr.on("data", (d) => (stderr += d.toString()));
    p.on("error", reject);
    p.on("close", (code) => {
      if (code === 0) return resolve();
      reject(new Error(`ffmpeg failed (code ${code}): ${stderr}`));
    });
  });
}

/* ===============================
   FIXED LOGO WATERMARK (FFmpeg)
   =============================== */

async function bakeLogoWatermark({ inputPath, outputPath }) {
  const logoPath = path.join(__dirname, "public", "watermark.png");

  if (!fs.existsSync(logoPath)) {
    throw new Error(`Watermark logo not found at ${logoPath}. Add public/watermark.png`);
  }

  return new Promise((resolve, reject) => {
    // BULLETPROOF watermark bake:
    // - Scale watermark by FIXED PIXEL HEIGHT (preserves logo aspect ratio, no squish)
    // - Force square pixels to avoid weird player stretching
    // - Overlay bottom-right
    const WM_H = 96;        // HUGE watermark (about 4x your original 24px)
    const WM_OPACITY = 0.95;
    const RIGHT = 24;
    const BOTTOM = 24;

    const filter =
      "[0:v]format=rgba,setsar=1[base];" +
      `[1:v]format=rgba,setsar=1,colorchannelmixer=aa=${WM_OPACITY},scale=-1:${WM_H}[wm];` +
      `[base][wm]overlay=x=W-w-${RIGHT}:y=H-h-${BOTTOM}:format=auto,setsar=1[outv]`;

    const args = [
      "-y",
      "-i", inputPath,
      "-i", logoPath,
      "-filter_complex", filter,
      "-map", "[outv]",
      "-map", "0:a?",
      "-c:v", "libx264",
      "-profile:v", "baseline",   // iPhone compatibility + fast decode
      "-level", "3.0",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",  // Fast start for streaming
      "-preset", "fast",          // Faster encode, still good quality
      "-crf", "23",               // Good quality
      outputPath
    ];

    const proc = spawn(ffmpegPath, args);

    proc.stderr.on("data", d => {
      console.log("[ffmpeg]", d.toString());
    });

    proc.on("error", reject);

    proc.on("close", code => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg watermark failed with code ${code}`));
    });
  });
}

// ==================================================
// MOTION ENFORCER (USED ONLY WHEN ANIMATING)
// Allows mouth movement but NO SPEECH / NO LIP-SYNC
// ==================================================

function enforceVisibleMotionNoSpeech(prompt) {
  const p0 = String(prompt || "").trim();

  // Remove speech-related intent but allow mouth movement
  const cleaned = p0
    .replace(/\b(talk|talking|speak|speaking|say|saying|whisper|whispering|sing|singing|lyrics|dialogue|conversation|lip\s*sync|lipsync|dub|voice|words|mouthing)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  const base = cleaned || "Subtle natural movement only.";

  const hardRules =
    "No talking, no forming words, no lip-sync, and no sound. " +
    "The mouth may move naturally but must not articulate speech. " +
    "No camera movement. Do not change clothing, lighting, background, or identity.";

  const forcedMotion =
    "Visible but natural motion includes two full blinks, gentle breathing, and a tiny head tilt.";

  return `${base}${base.endsWith(".") ? "" : "."} ${forcedMotion} ${hardRules}`
    .replace(/\s+/g, " ")
    .trim();
}

// ---- ROOT ROUTE (serves main UI) ----
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ---- STRIPE CHECKOUT ROUTE (with manual capture) ----
app.post("/create-checkout-session", async (req, res) => {
  try {
    // Generate a unique jobId BEFORE creating session
    // Frontend should pass this, or we generate one
    const jobId = req.body.jobId || `job-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    console.log(`💳 Creating checkout session with jobId: ${jobId}`);
    
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: { name: "Photo Animation" },
            unit_amount: 499, // $4.99 in cents
          },
          quantity: 1,
        },
      ],
      // Session-level metadata
      metadata: {
        jobId: jobId
      },
      // Payment intent settings for manual capture
      payment_intent_data: {
        capture_method: "manual",
        metadata: {
          jobId: jobId
        }
      },
      success_url: `${req.protocol}://${req.get("host")}/success.html?jobId=${jobId}`,
      cancel_url: `${req.protocol}://${req.get("host")}/cancel.html?jobId=${jobId}`,
    });

    console.log(`✅ Checkout session created: sessionId=${session.id}, jobId=${jobId}`);
    
    res.json({ url: session.url, jobId: jobId });
  } catch (err) {
    console.error("Stripe error:", err);
    res.status(500).send("Error creating checkout session");
  }
});

// ---- SUCCESS & CANCEL PAGES ----
app.get("/success", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "success.html"));
});

app.get("/cancel", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "cancel.html"));
});

// ---- AI ROUTES (KEEP EXISTING LOGIC) ----

app.post("/animate_photo", async (req, res) => {
  console.log('➡️  /animate_photo called');

  // Extract jobId for payment tracking (if this is a paid animation)
  const jobId = req.body.jobId || null;
  const isPaidJob = !!jobId;
  
  if (isPaidJob) {
    console.log(`💰 Paid animation job: ${jobId}`);
  }

  try {
    if (!AIML_API_KEY) {
      console.error('❌ AIML_API_KEY missing');
      
      // If this is a paid job that failed, cancel the payment
      if (isPaidJob) {
        await handleJobCompletion(jobId, false);
      }
      
      return res.status(500).json({ error: 'Kling API key missing.' });
    }

    const { imageBase64, prompt, hideWatermark } = req.body || {};

    if (!imageBase64) {
      console.error("❌ No imageBase64 in request body");
      
      if (isPaidJob) {
        await handleJobCompletion(jobId, false);
      }
      
      return res.status(400).json({ error: "No image data provided (imageBase64 missing)" });
    }

    if (!prompt) {
      console.error("❌ No prompt in request body");
      
      if (isPaidJob) {
        await handleJobCompletion(jobId, false);
      }
      
      return res.status(400).json({ error: "No prompt provided for animation" });
    }

    // Use imageBase64 directly as the image payload for Kling
    // Prepend data URL prefix if not already present
    const base64Image = imageBase64.startsWith("data:")
      ? imageBase64
      : `data:image/jpeg;base64,${imageBase64}`;

    // Apply motion booster (allows mouth movement, bans speech/lip-sync)
    const finalPrompt = enforceVisibleMotionNoSpeech(prompt);
    console.log('🎬 finalPrompt:', finalPrompt);

    const url = 'https://api.aimlapi.com/v2/generate/video/kling/generation';

    console.log('🔁 Creating Kling job with model kling-video/v2.1/standard/image-to-video');

    const createResp = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${AIML_API_KEY}`,
        'Content-Type': 'application/json',
        },
        body: JSON.stringify({
        // Basic-access image-to-video model
        model: 'kling-video/v2.1/standard/image-to-video',
        image_url: base64Image, // base64 data URL from the frontend
          prompt: finalPrompt,  // Motion-boosted prompt
          type: 'image-to-video',
        duration: '5', // docs use a string
      }),
    });

    if (!createResp.ok) {
      const errText = await createResp.text();
      console.error('❌ Kling create error:', createResp.status, errText);
      
      if (isPaidJob) {
        await handleJobCompletion(jobId, false);
      }
      
      return res.status(500).json({
        error: 'Failed to create Kling generation job.',
        details: errText,
      });
    }

    const job = await createResp.json();
    console.log('✅ Kling create response:', JSON.stringify(job, null, 2));

    // Try to grab a video URL directly if it's already available
    let providerVideoUrl =
      job.video?.url ||
      job.video_url ||
      job.output?.[0]?.url ||
      job.result?.video_url ||
      job.result?.output?.[0]?.url;

    // If not available directly, poll for it
    if (!providerVideoUrl) {
      const generationId = job.generation_id || job.id || job.task_id;

      if (!generationId) {
        console.error('❌ No generation_id / id / task_id in Kling response');
        
        if (isPaidJob) {
          await handleJobCompletion(jobId, false);
        }
        
        return res.status(500).json({
          error: 'Kling did not return a video URL or generation ID.',
          details: job,
        });
      }

      console.log('⏳ Polling Kling status for id:', generationId);

      const maxWaitMs = 5 * 60 * 1000; // 5 minutes
      const intervalMs = 10_000;
      const start = Date.now();

      while (Date.now() - start < maxWaitMs) {
        await new Promise((r) => setTimeout(r, intervalMs));

        const statusResp = await fetch(
          `${url}?generation_id=${encodeURIComponent(generationId)}`,
          {
            method: 'GET',
            headers: {
              Authorization: `Bearer ${AIML_API_KEY}`,
              'Accept': 'application/json',
            },
          }
        );

        if (!statusResp.ok) {
          const errText = await statusResp.text();
          console.error('❌ Kling status error:', statusResp.status, errText);
          
          if (isPaidJob) {
            await handleJobCompletion(jobId, false);
          }
          
      return res.status(500).json({
            error: 'Error checking Kling job status.',
            details: errText,
          });
        }

        const statusData = await statusResp.json();
        console.log('🔎 Kling status:', statusData.status || statusData);

        const status = statusData.status || statusData.state;

        // See if we got a video URL on a later check
        const pollUrl =
          statusData.video?.url ||
          statusData.video_url ||
          statusData.output?.[0]?.url ||
          statusData.result?.video_url ||
          statusData.result?.output?.[0]?.url;

        if ((status === 'completed' || status === 'succeeded') && pollUrl) {
          console.log('🎉 Kling job completed');
          providerVideoUrl = pollUrl;
          break;
        }

        if (status === 'failed' || status === 'error') {
          console.error('❌ Kling job failed:', JSON.stringify(statusData, null, 2));
          
          if (isPaidJob) {
            await handleJobCompletion(jobId, false);
          }
          
          return res.status(500).json({
            error: 'Kling generation failed.',
            details: statusData,
          });
        }
      }

      if (!providerVideoUrl) {
        console.error('❌ Timed out waiting for Kling video');
        
        if (isPaidJob) {
          await handleJobCompletion(jobId, false);
        }
        
        return res.status(500).json({
          error: 'Timed out waiting for Kling video.',
        });
      }
    }

    // Now we have providerVideoUrl - download and optionally watermark it
    console.log('📥 Downloading video from provider...');

    const publicDir = path.join(process.cwd(), "public");
    const outDir = path.join(publicDir, "outputs");
    ensureDir(outDir);

    const id = `anim-${Date.now()}`;
    const rawPath = path.join(outDir, `${id}-raw.mp4`);
    const wmPath = path.join(outDir, `${id}-wm.mp4`);

    // Download provider MP4 to disk
    await downloadToFile(providerVideoUrl, rawPath);
    console.log('✅ Video downloaded to:', rawPath);

    // Decide watermark:
    // - Dev Free / first free: watermark ON by default (hideWatermark = false/undefined)
    // - Paid: hideWatermark = true => watermark OFF
    let finalPath = rawPath;
    let wasWatermarked = false;

    if (!hideWatermark) {
      try {
        console.log('🔖 Baking SeeAgain logo watermark into video...');
        await bakeLogoWatermark({ inputPath: rawPath, outputPath: wmPath });
        console.log('✅ Watermarked video saved to:', wmPath);
        finalPath = wmPath;
        wasWatermarked = true;

        // Clean up raw file
        fs.promises.unlink(rawPath).catch(() => {});
      } catch (err) {
        console.error("⚠️ Watermark failed, returning raw video:", err.message);
        finalPath = rawPath;
        wasWatermarked = false;
      }
    } else {
      console.log('💎 Paid animation - no watermark');
    }

    // SUCCESS! If this is a paid job, capture the payment
    if (isPaidJob) {
      console.log(`✅ Animation succeeded for paid job: ${jobId}`);
      await handleJobCompletion(jobId, true);
    }

    const finalFilename = path.basename(finalPath);
    return res.json({
      ok: true,
      videoUrl: `/outputs/${finalFilename}`,
      downloadUrl: `/api/download/${finalFilename}`,
      watermarked: wasWatermarked,
      jobId: jobId
    });

  } catch (err) {
    console.error('💥 Error in /animate_photo:', err);
    
    // If this is a paid job that failed, cancel the payment
    if (isPaidJob) {
      await handleJobCompletion(jobId, false);
    }
    
    res.status(500).json({ error: err.message || 'Unexpected error in /animate_photo.' });
  }
});

// ==============================================================================
// MANUAL JOB COMPLETION ENDPOINT (for external render pipelines if needed)
// ==============================================================================

app.post("/jobs/:jobId/complete", async (req, res) => {
  const { jobId } = req.params;
  const { status } = req.body || {};
  
  if (!jobId) {
    return res.status(400).json({ error: "Missing jobId" });
  }
  
  if (status !== "success" && status !== "failed") {
    return res.status(400).json({ error: "Status must be 'success' or 'failed'" });
  }
  
  console.log(`📨 Job completion API called: jobId=${jobId}, status=${status}`);
  
  await handleJobCompletion(jobId, status === "success");
  
  const record = getPayment(jobId);
  
  res.json({
    ok: true,
    jobId,
    paymentStatus: record?.status || "unknown"
  });
});

// ==================================================
// SUGGESTED PROMPTS (ONE SENTENCE, HUMAN, SIMPLE)
// ==================================================

function buildSuggestedPromptsSimple(context = "general") {
  const sets = {
    couple: [
      "The couple blink softly as their smiles subtly shift.",
      "Both partners take a gentle breath and make a slight, natural head adjustment.",
      "One partner's expression relaxes while the other blinks naturally."
    ],

    parentBaby: [
      "The baby's fingers make a tiny natural movement while the adult remains calm.",
      "The adult gently blinks while holding the baby securely.",
      "The baby shifts slightly as the adult's expression softens."
    ],

    friends: [
      "The two friends blink naturally and make a small, relaxed posture adjustment.",
      "One friend subtly shifts their shoulders while both maintain easy smiles.",
      "Both friends take a gentle breath and slightly adjust their expressions."
    ],

    portrait: [
      "The person blinks twice and their expression softens slightly.",
      "A gentle breath causes a tiny, natural head movement.",
      "The person's eyes briefly shift focus before returning to stillness."
    ],

    general: [
      "The people blink naturally and make a subtle head movement.",
      "A gentle breath causes a slight, relaxed posture adjustment.",
      "Expressions soften briefly before returning to stillness."
    ]
  };

  return sets[context] || sets.general;
}

// Helper to ensure every AI-generated suggestion contains visible motion
function ensureVisibleMotion(prompt) {
  const lower = prompt.toLowerCase();

  // Detect if the suggestion already contains visible-motion verbs
  const hasStrongVerb =
    lower.includes("blink") ||
    lower.includes("blinks") ||
    lower.includes("blinked") ||
    lower.includes("eyes") ||
    lower.includes("tilt") ||
    lower.includes("nod") ||
    lower.includes("smile") ||
    lower.includes("grin") ||
    lower.includes("turn") ||
    lower.includes("head");

  // If it already contains a clear visible action → leave it as-is
  if (hasStrongVerb) return prompt;

  // Otherwise, upgrade it with a guaranteed visible action
  return (
    prompt.trim().replace(/\.*$/, "") +
    ". They blink clearly twice and make a tiny, natural head tilt before returning to a still pose."
  );
}

// Filter out "header" / meta lines the model sometimes returns
function isJunkSuggestionLine(line) {
  const s = (line || "").trim();
  if (!s) return true;

  // Common prefaces we DO NOT want as a suggestion button
  if (/^here (are|is)\b/i.test(s)) return true;
  if (/^below are\b/i.test(s)) return true;
  if (/^these (are|would be)\b/i.test(s)) return true;
  if (/^sure[,!]/i.test(s)) return true;

  // Meta wording about the task itself
  if (/\banimation prompts?\b/i.test(s) && s.length < 120) return true;
  if (/\b(3|three)\b.*\b(prompts?|suggestions?)\b/i.test(s) && s.length < 140) return true;

  // If the line is basically a label, not an instruction
  if (/^prompt\s*[:\-]/i.test(s)) return true;

  return false;
}

// ---- SIMPLE GEMINI SUGGESTED PROMPTS (OLD-STYLE) ----

// Helper to clean up Gemini output lines
function cleanSuggestionLine(line) {
  if (!line) return "";

  // Strip leading numbers / bullets like "1. ", "2) ", "- "
  let cleaned = line
    .replace(/^\s*(?:\d+[\).\-\:]\s*|[-*]\s*)/, "")
    .trim();

  // Drop obvious meta lines
  if (/^here (are|is)\b/i.test(cleaned)) return "";
  if (/^suggestion\s*\d+/i.test(cleaned)) return "";

  // Remove outer quotes
  cleaned = cleaned.replace(/^[""](.*)[""]$/, "$1").trim();

  if (!cleaned) return "";

  // Avoid the word "subject" – make it sound more natural
  cleaned = cleaned
    .replace(/\bthe subjects'\b/gi, "the people's")
    .replace(/\bsubjects'\b/gi, "people's")
    .replace(/\bthe subjects\b/gi, "the people")
    .replace(/\bsubject's\b/gi, "person's")
    .replace(/\bthe subject\b/gi, "the person")
    .replace(/\bsubjects\b/gi, "people")
    .replace(/\bsubject\b/gi, "person");

  // Enforce *one* sentence max
  const match = cleaned.match(/[^.?!]+[.?!]?/);
  if (match) cleaned = match[0].trim();

  // Block talking / speechy motions
  const lower = cleaned.toLowerCase();
  const speechWords = [
    "say", "says", "said",
    "talk", "talks", "talking",
    "speak", "speaks", "speaking",
    "whisper", "whispers", "whispering",
    "sing", "sings", "singing",
    "mouths the words", "lip sync"
  ];
  if (speechWords.some((w) => lower.includes(w))) {
    return "";
  }

  // Make sure it ends with punctuation
  if (!/[.!?]$/.test(cleaned)) {
    cleaned += ".";
  }

  return cleaned;
}

app.post("/suggest-prompts", async (req, res) => {
  // Very simple, "old style" fallbacks in case Gemini fails
  const fallbackSuggestions = [
    "The person in the photo gives a slow, full blink and a small, natural head tilt.",
    "Their expression softens as they make a clearly visible but gentle eye movement.",
    "The person performs a noticeable blink and a relaxed, subtle posture adjustment."
  ];

  try {
    const { imageBase64 } = req.body || {};

    if (!imageBase64) {
      console.warn("No imageBase64 received in /suggest-prompts");
      return res.json({ suggestions: fallbackSuggestions });
    }

    const apiKey = GEMINI_API_KEY;
    if (!apiKey) {
      console.error("Missing GEMINI_API_KEY in environment");
      return res.json({ suggestions: fallbackSuggestions });
    }

    const url =
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

    const promptText = `
You create very short animation prompts for an image-to-video model called Kling.

GOAL:
- Subtle, portrait-friendly motion that clearly reads on camera.

RULES:
- Look at the image and write exactly 3 suggestions.
- Each suggestion must be ONE sentence only.
- Motions must be clearly visible on video while remaining natural.
- Use motions such as full blinks, small but noticeable head movements, gentle posture shifts, soft breathing, or clear eye direction changes.
- If a motion could be mistaken for a still image, make it slightly stronger so it is unmistakably animated.
- Do NOT describe anyone talking, singing, or mouthing words.
- Do NOT mention "subject" or "camera" in your wording.
- Do NOT add or invent new objects, clothes, text, or background details.

FORMAT:
- Return just 3 lines of text.
- Each line is one complete animation suggestion, tailored to the specific image.
`.trim();

    const body = {
      contents: [
        {
          parts: [
            {
              inlineData: {
                mimeType: "image/jpeg",
                data: imageBase64, // base64 string from the frontend
              },
            },
            {
              text: promptText,
            },
          ],
        },
      ],
    };

    const resp = await fetch(`${url}?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errorText = await resp.text();
      console.error("Gemini error:", resp.status, errorText);
      return res.json({ suggestions: fallbackSuggestions });
    }

    const data = await resp.json();

    const parts = data?.candidates?.[0]?.content?.parts || [];
    const textPart = parts.find((p) => typeof p.text === "string");
    const rawText = textPart?.text?.trim() || "";
    console.log("Gemini raw suggestions:", rawText);

    // Turn Gemini output into up to 3 clean, one-line prompts
    const rawLines = rawText.split("\n");
    let suggestions = rawLines
      .map(cleanSuggestionLine)
      .filter((line) => line.length > 0)
      .slice(0, 3);

    // If Gemini gave us nothing usable, fall back
    if (!suggestions.length) {
      suggestions = fallbackSuggestions;
    }

    return res.json({ suggestions });
  } catch (err) {
    console.error("Error in /suggest-prompts:", err);
    return res.json({
      suggestions: fallbackSuggestions,
      error: "Gemini request failed, using fallback prompts.",
    });
  }
});

// ==============================================================================
// SAFETY TIMEOUT: Cancel stuck authorizations
// ==============================================================================

const AUTHORIZATION_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours
const CLEANUP_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

async function cleanupStuckAuthorizations() {
  console.log("🧹 Running stuck authorization cleanup...");
  
  const now = Date.now();
  let cleanedCount = 0;
  
  for (const [jobId, record] of Object.entries(paymentsStore)) {
    // Only process "authorized" status that hasn't been completed
    if (record.status !== "authorized") continue;
    
    const age = now - record.createdAt;
    
    if (age > AUTHORIZATION_TIMEOUT_MS) {
      console.log(`⏰ Authorization timeout: jobId=${jobId}, age=${Math.round(age / 60000)}min`);
      
      try {
        await cancelPayment(jobId);
        cleanedCount++;
      } catch (err) {
        console.error(`❌ Failed to cancel stuck auth for jobId=${jobId}:`, err.message);
      }
    }
  }
  
  if (cleanedCount > 0) {
    console.log(`🧹 Cleaned up ${cleanedCount} stuck authorizations`);
  } else {
    console.log("🧹 No stuck authorizations found");
  }
}

// Run cleanup on startup (after a short delay)
setTimeout(cleanupStuckAuthorizations, 10000);

// Run cleanup every 30 minutes
setInterval(cleanupStuckAuthorizations, CLEANUP_INTERVAL_MS);

// ===== AUTO-CLEANUP OLD OUTPUT VIDEOS (OLDER THAN 7 DAYS) =====

// Outputs folder inside /public for static serving
const OUTPUTS_DIR = path.join(__dirname, "public", "outputs");
const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function cleanupOldOutputs() {
  try {
    if (!fs.existsSync(OUTPUTS_DIR)) {
      fs.mkdirSync(OUTPUTS_DIR, { recursive: true });
      return;
    }

    const now = Date.now();
    const files = fs.readdirSync(OUTPUTS_DIR);

    for (const file of files) {
      const filePath = path.join(OUTPUTS_DIR, file);

      let stats;
      try {
        stats = fs.statSync(filePath);
      } catch {
        continue;
      }

      if (!stats.isFile()) continue;

      const age = now - stats.mtimeMs;
      if (age > ONE_WEEK_MS) {
        try {
          fs.unlinkSync(filePath);
          console.log("🧹 Deleted old output:", file);
        } catch {}
      }
    }
  } catch (err) {
    console.warn("Cleanup skipped:", err?.message || err);
  }
}

// Run cleanup once at startup
cleanupOldOutputs();

// Run cleanup every 12 hours
setInterval(cleanupOldOutputs, 12 * 60 * 60 * 1000);

// ---- SERVER LISTENER ----
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Stripe webhook endpoint: POST /stripe/webhook`);
  console.log(`Manual capture mode enabled for all paid animations`);
});

export default app;
