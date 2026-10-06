# Media

Animated previews for the documents. Each file is an animated WebP image, 432 × 540 pixels at 12 frames a second, with no sound. GitHub shows it in a README with no upload step.

- `peekumi-launch.webp`: Peekumi in 35 seconds. The README shows it.
- `peekumi-review-loop.webp`: one review loop with two rounds, in 45 seconds. `docs/WORKFLOW.md` shows it.

To make a new preview from a video, run these commands. They need `ffmpeg` and `img2webp` (from libwebp).

```sh
mkdir frames
ffmpeg -i video.mp4 -vf "fps=12,scale=432:540:flags=lanczos" frames/f%04d.png
img2webp -loop 0 -d 83 -lossy -q 60 -m 6 -mixed frames/f*.png -o docs/media/name.webp
```
