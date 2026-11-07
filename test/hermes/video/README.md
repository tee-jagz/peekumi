# Demo video tools

This package builds the local Hermes review video.
It has no plugin runtime role.

- Remotion draws the camera and cursor at 60 frames per second.
- HyperFrames renders the short identity strip as a PNG sequence.
- FFmpeg prepares the native footage and encodes the delivery MP4.
- yt-dlp imports source URLs. This build uses a loopback URL for our own footage.
- The current Google Charon narration stays unchanged. Whisper is not used.

The native recording plays at its original speed.
The capture follows the existing narration's section times.
The editor checks the timing drift before it renders.
The cursor follows recorded pointer targets and clicks.
It has no tool labels or large red cursor markers.
Camera and cursor annotations are disclosed on screen.

## Prepare

Run `npm ci --ignore-scripts` in this directory.
Install FFmpeg and yt-dlp first.
Set `PEEKUMI_VIDEO_BROWSER` to a headless Chrome executable.
The tested Mac uses Playwright's cached `chrome-headless-shell`.
System Chrome stalled on the HyperFrames capture. The dedicated headless build works.

Use the existing Google narration in `test-results/hermes/benefit-demo/`.
Record the native turn from the Peekumi root with the usual isolated Hermes settings:

```sh
PEEKUMI_NATIVE_SCENARIO=1 PEEKUMI_VIDEO_CAPTURE=framework node test/hermes/native-pane.mjs
node test/hermes/video/hyperframes.mjs
node test/hermes/video/prepare.mjs
node test/hermes/video/render.mjs
```

The HyperFrames build disables telemetry and loads GSAP from the installed package.
It needs no remote assets.
The source importer checks that yt-dlp preserves the video bytes.
Remotion uses one continuous native video track. It does not speed up the footage.
The final FFmpeg step copies the Google audio stream.
The output uses H.264, AAC, `yuv420p` and fast-start MP4.
The renderer checks the audio packet hash and decodes the complete output.

## Check

Run `npm test` here for camera continuity and cursor timing.
Run `npm run verify` after rendering for constant frame rate and browser playback.
The native scenario verifies real hooks, tools, findings and two measurements.
Set `PEEKUMI_VIDEO_STILLS_ONLY=1` to inspect sample frames before a full render.
Artifacts stay in `test-results/hermes/framework-demo/`.
The delivery file is `test-results/hermes/release-google/peekumi-remotion.mp4`.
Thread playback remains unverified.

## References

- [Remotion renderer](https://www.remotion.dev/docs/renderer/render-media)
- [HyperFrames rendering](https://hyperframes.app/docs/5-packages/cli)
- [HyperFrames GSAP timelines](https://hyperframes.app/docs/3-guides/3-gsap-animation)
- [yt-dlp](https://github.com/yt-dlp/yt-dlp)
