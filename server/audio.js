import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function convertToWav(inputPath, outputPath) {
  try {
    await execFileAsync(
      "ffmpeg",
      [
        "-y",
        "-v",
        "error",
        "-i",
        inputPath,
        "-ar",
        "16000",
        "-ac",
        "1",
        "-c:a",
        "pcm_s16le",
        outputPath
      ],
      { timeout: 60000, maxBuffer: 1024 * 1024 }
    );
  } catch (error) {
    const detail = error.stderr?.trim() || error.message;
    throw new Error(`Could not decode recorded audio with ffmpeg: ${detail}`);
  }
}
