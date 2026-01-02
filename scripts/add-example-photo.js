import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Resolve __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 🖼️ SOURCE: where the example photo lives on your machine.
// Save your photo as "seeagain-example.jpg" in your Downloads folder
// before running this script.
const sourcePath = path.resolve(
  process.env.HOME || process.env.USERPROFILE || "",
  "Downloads",
  "seeagain-example.jpg"
);

// 🗂️ DEST: public/sample-photo.jpg inside this project
const destPath = path.resolve(__dirname, "..", "public", "sample-photo.jpg");

if (!fs.existsSync(sourcePath)) {
  console.error(
    "Source example photo not found at:",
    sourcePath,
    "\n\nMake sure you saved your photo as 'seeagain-example.jpg' in your Downloads folder."
  );
  process.exit(1);
}

// Ensure public/ exists
const publicDir = path.dirname(destPath);
if (!fs.existsSync(publicDir)) {
  fs.mkdirSync(publicDir, { recursive: true });
}

fs.copyFileSync(sourcePath, destPath);
console.log("✅ Example photo copied to:", destPath);



