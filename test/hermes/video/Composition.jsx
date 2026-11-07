/** @module Remotion composes the native recording with subpixel camera and cursor motion. */
import React from "react";
import {
  AbsoluteFill,
  Composition,
  OffthreadVideo,
  Img,
  interpolate,
  registerRoot,
  staticFile,
  useCurrentFrame,
  getInputProps,
} from "remotion";
import { cameraAt, pointerAt } from "./timeline.mjs";
function Review(props) {
  const frame = useCurrentFrame(),
    seconds = frame / props.fps;
  const camera = cameraAt(props.camera, seconds),
    scale = 0.8 * camera.z;
  const cursor = pointerAt(props.actions, seconds);
  const chapter =
    props.chapters.findLast((clip) => clip.start <= seconds) ||
    props.chapters[0];
  const elapsed = seconds - chapter.start;
  const intro = frame < 120;
  const lastFrames = Math.ceil(props.duration * props.fps) - frame;
  const outro = lastFrames <= 120;
  const brandFrame = intro ? frame : 120 - lastFrames;
  const brandName = `brand/frame_${String(Math.max(0, Math.min(119, brandFrame)) + 1).padStart(6, "0")}.png`;
  return (
    <AbsoluteFill
      style={{
        backgroundColor: "#101827",
        color: "#f5f8ff",
        fontFamily: "Arial, sans-serif",
      }}
    >
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          height: 28,
          width: 1280,
          padding: "8px 18px",
          fontSize: 11,
          color: "#b7c8df",
          background: "#080f1b",
        }}
      >
        NATIVE HERMES DEMO · Scripted provider · Actual tools and measurements ·
        Edited camera and cursor
      </div>
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 28,
          width: 1280,
          height: 800,
          overflow: "hidden",
          background: "white",
        }}
      >
        <div
          style={{
            position: "absolute",
            left: 640 - camera.x * scale,
            top: 400 - camera.y * scale,
            width: 1600,
            height: 1000,
            transform: `scale(${scale})`,
            transformOrigin: "0 0",
            willChange: "transform",
          }}
        >
          <OffthreadVideo
            src={staticFile("native.mp4")}
            startFrom={Math.round(props.sourceStart * props.fps)}
            muted
            style={{ width: 1600, height: 1000 }}
          />
          {cursor && (
            <svg
              width="26"
              height="32"
              viewBox="0 0 26 32"
              style={{
                position: "absolute",
                left: cursor.x - 1,
                top: cursor.y - 1,
                overflow: "visible",
                filter: "drop-shadow(0 1px 1px #0005)",
              }}
            >
              <path
                d="M2 1 L2 24 L8 18 L13 29 L17 27 L12 16 L21 16 Z"
                fill="white"
                stroke="#172234"
                strokeWidth="1.5"
                strokeLinejoin="round"
              />
            </svg>
          )}
          {props.actions
            .filter(
              (action) =>
                action.type === "click" &&
                seconds >= action.at &&
                seconds < action.at + 0.32,
            )
            .map((action, index) => (
              <div
                key={index}
                style={{
                  position: "absolute",
                  left: action.x - 18,
                  top: action.y - 18,
                  width: 36,
                  height: 36,
                  border: "2px solid #3985ed",
                  borderRadius: "50%",
                  opacity: 1 - (seconds - action.at) / 0.32,
                  transform: `scale(${0.55 + (seconds - action.at) * 1.7})`,
                }}
              />
            ))}
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 828,
          width: 1280,
          height: 72,
          padding: "9px 23px",
          background: "#101827",
          borderTop: "1px solid #344761",
        }}
      >
        <div
          style={{
            fontSize: 23,
            fontWeight: 700,
            transform: `translateY(${interpolate(elapsed, [0, 0.4], [4, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })}px)`,
            opacity: interpolate(elapsed, [0, 0.3], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            }),
          }}
        >
          {chapter.title}
        </div>
        <div style={{ fontSize: 16, marginTop: 6, color: "#bdcde1" }}>
          {chapter.detail}
        </div>
        {(intro || outro) && (
          <Img
            src={staticFile(brandName)}
            style={{ position: "absolute", inset: 0, width: 1280, height: 72 }}
          />
        )}
        <div
          style={{
            position: "absolute",
            height: 2,
            left: 0,
            bottom: 0,
            width: (1280 * seconds) / props.duration,
            background: "#65a8ff",
          }}
        />
      </div>
    </AbsoluteFill>
  );
}
const Root = () => {
  const props = getInputProps();
  return (
    <Composition
      id="PeekumiReview"
      component={Review}
      width={1280}
      height={900}
      fps={60}
      durationInFrames={Math.ceil(props.duration * 60)}
      defaultProps={props}
    />
  );
};
registerRoot(Root);
