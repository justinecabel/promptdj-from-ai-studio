/**
 * @fileoverview Control real time music with text prompts
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {css, CSSResultGroup, html, LitElement, svg} from 'lit';
import {customElement, property, query, state} from 'lit/decorators.js';
import {classMap} from 'lit/directives/class-map.js';
import {styleMap} from 'lit/directives/style-map.js';



import {
  GoogleGenAI,
  type LiveMusicGenerationConfig,
  type LiveMusicServerMessage,
  type LiveMusicSession,
} from '@google/genai';
import {decode, decodeAudioData} from './utils';
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  apiVersion: 'v1alpha',
});
let model = 'lyria-realtime-exp';

interface Prompt {
  readonly promptId: string;
  readonly color: string;
  text: string;
  weight: number;
}

type PlaybackState = 'stopped' | 'playing' | 'loading' | 'paused';

/** Throttles a callback to be called at most once per `freq` milliseconds. */
function throttle(func: (...args: unknown[]) => void, delay: number) {
  let lastCall = 0;
  return (...args: unknown[]) => {
    const now = Date.now();
    const timeSinceLastCall = now - lastCall;
    if (timeSinceLastCall >= delay) {
      func(...args);
      lastCall = now;
    }
  };
}

const PROMPT_TEXT_PRESETS = [
  'Bossa Nova',
  'Minimal Techno',
  'Drum and Bass',
  'Post Punk',
  'Shoegaze',
  'Funk',
  'Chiptune',
  'Lush Strings',
  'Sparkling Arpeggios',
  'Staccato Rhythms',
  'Punchy Kick',
  'Dubstep',
  'K Pop',
  'Neo Soul',
  'Trip Hop',
  'Thrash',
];

const COLORS = [
  '#9900ff',
  '#5200ff',
  '#ff25f6',
  '#2af6de',
  '#ffdd28',
  '#3dffab',
  '#d8ff3e',
  '#d9b2ff',
];

function getUnusedRandomColor(usedColors: string[]): string {
  const availableColors = COLORS.filter((c) => !usedColors.includes(c));
  if (availableColors.length === 0) {
    // If no available colors, pick a random one from the original list.
    return COLORS[Math.floor(Math.random() * COLORS.length)];
  }
  return availableColors[Math.floor(Math.random() * availableColors.length)];
}

// WeightSlider component
// -----------------------------------------------------------------------------
/** A slider for adjusting and visualizing prompt weight. */
@customElement('weight-slider')
class WeightSlider extends LitElement {
  static override styles = css`
    :host {
      cursor: ns-resize;
      position: relative;
      height: 100%;
      display: flex;
      justify-content: center;
      flex-direction: column;
      align-items: center;
      padding: 5px;
    }
    .scroll-container {
      width: 100%;
      flex-grow: 1;
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
    }
    .value-display {
      font-size: 1.3vmin;
      font-family: inherit; /* Inherit sans-serif font from host */
      color: #ccc;
      margin: 0.5vmin 0;
      user-select: none;
      text-align: center;
    }
    .slider-container {
      position: relative;
      width: 12px; /* Slightly wider for a more substantial feel */
      height: 100%;
      background-color: rgba(255,255,255,0.1); /* Light track on dark bg, MD3 style */
      border-radius: 8px; /* More expressive */
    }
    #thumb {
      position: absolute;
      bottom: 0;
      left: 0;
      width: 100%;
      border-radius: 8px; /* Match track rounding */
      /* backgroundColor is set via styleMap */
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.4); /* Softer base shadow */
      /* "Wiggly" inspired transition for a bouncy feel */
      transition: height 0.35s cubic-bezier(0.34, 1.56, 0.64, 1),
                  box-shadow 0.3s ease;
    }
  `;

  @property({type: Number}) value = 0; // Range 0-2
  @property({type: String}) color = '#000';

  @query('.scroll-container') private scrollContainer!: HTMLDivElement;

  @state() private isDragging = false;
  private dragStartPos = 0;
  private dragStartValue = 0;
  private containerBounds: DOMRect | null = null;

  constructor() {
    super();
    this.handlePointerDown = this.handlePointerDown.bind(this);
    this.handlePointerMove = this.handlePointerMove.bind(this);
    this.handleTouchMove = this.handleTouchMove.bind(this);
    this.handlePointerUp = this.handlePointerUp.bind(this);
  }

  private handlePointerDown(e: PointerEvent) {
    e.preventDefault();
    this.containerBounds = this.scrollContainer.getBoundingClientRect();
    this.dragStartPos = e.clientY;
    this.dragStartValue = this.value;
    document.body.classList.add('dragging');
    this.isDragging = true;
    this.setAttribute('is-dragging', ''); // Set attribute for styling
    window.addEventListener('pointermove', this.handlePointerMove);
    window.addEventListener('touchmove', this.handleTouchMove, {
      passive: false,
    });
    window.addEventListener('pointerup', this.handlePointerUp, {once: true});
    this.updateValueFromPosition(e.clientY);
  }

  private handlePointerMove(e: PointerEvent) {
    this.updateValueFromPosition(e.clientY);
  }

  private handleTouchMove(e: TouchEvent) {
    e.preventDefault();
    this.updateValueFromPosition(e.touches[0].clientY);
  }

  private handlePointerUp(e: PointerEvent) {
    window.removeEventListener('pointermove', this.handlePointerMove);
    window.removeEventListener('touchmove', this.handleTouchMove); // Ensure touchmove is also removed
    document.body.classList.remove('dragging');
    this.isDragging = false;
    this.removeAttribute('is-dragging'); // Remove attribute
    this.containerBounds = null;
  }

  private handleWheel(e: WheelEvent) {
    e.preventDefault();
    const delta = e.deltaY;
    this.value = this.value + delta * -0.005;
    this.value = Math.max(0, Math.min(2, this.value));
    this.dispatchInputEvent();
  }

  private updateValueFromPosition(clientY: number) {
    if (!this.containerBounds) return;

    const trackHeight = this.containerBounds.height;
    // Calculate position relative to the top of the track
    const relativeY = clientY - this.containerBounds.top;
    // Invert and normalize (0 at bottom, 1 at top)
    const normalizedValue =
      1 - Math.max(0, Math.min(trackHeight, relativeY)) / trackHeight;
    // Scale to 0-2 range
    this.value = normalizedValue * 2;

    this.dispatchInputEvent();
  }

  private dispatchInputEvent() {
    this.dispatchEvent(new CustomEvent<number>('input', {detail: this.value}));
  }

  override render() {
    const thumbHeightPercent = (this.value / 2) * 100;
    const thumbStyle = styleMap({
      height: `${thumbHeightPercent}%`,
      backgroundColor: this.color,
      display: this.value > 0.01 ? 'block' : 'none',
    });
    const displayValue = this.value.toFixed(2);

    return html`
      <style>
        /* Dynamic hover/active styles for the thumb */
        :host(:hover) #thumb {
          box-shadow: 0 2px 6px rgba(0,0,0,0.5), 0 0 8px 2px ${this.color}66; /* Glow with thumb color */
        }
        :host([is-dragging]) #thumb {
          box-shadow: 0 3px 8px rgba(0,0,0,0.6), 0 0 12px 4px ${this.color}99; /* Stronger glow */
        }

        @media (max-width: 600px) and (orientation: portrait) {
          :host {
            padding: 3px; /* Reduced padding */
          }
          .value-display {
            font-size: clamp(10px, 2vmin, 12px); /* Smaller font */
            margin: 0.3vmin 0;
          }
          .slider-container {
            width: 10px; /* Narrower slider track */
            border-radius: 6px;
          }
          #thumb {
            border-radius: 6px;
          }
        }
      </style>
      <div
        class="scroll-container"
        @pointerdown=${this.handlePointerDown}
        @wheel=${this.handleWheel}>
        <div class="slider-container">
          <div id="thumb" style=${thumbStyle}></div>
        </div>
        <div class="value-display">${displayValue}</div>
      </div>
    `;
  }
}

// Base class for icon buttons.
class IconButton extends LitElement {
  static override styles = css`
    :host {
      position: relative;
      display: flex;
      align-items: center;
      justify-content: center;
      pointer-events: none;
    }
    :host(:hover) svg {
      transform: scale(1.2);
    }
    svg {
      width: 100%;
      height: 100%;
      transition: transform 0.5s cubic-bezier(0.25, 1.56, 0.32, 0.99);
    }
    .hitbox {
      pointer-events: all;
      position: absolute;
      width: 65%;
      aspect-ratio: 1;
      top: 9%;
      border-radius: 50%;
      cursor: pointer;
    }
  ` as CSSResultGroup;

  // Method to be implemented by subclasses to provide the specific icon SVG
  protected renderIcon() {
    return svg``; // Default empty icon
  }

  private renderSVG() {
    return html` <svg
      width="140"
      height="140"
      viewBox="0 -10 140 150"
      fill="none"
      xmlns="http://www.w3.org/2000/svg">
      <rect
        x="22"
        y="6"
        width="96"
        height="96"
        rx="48"
        fill="rgba(0, 0, 0, 0.2)" />  <!-- Slightly darker background -->
      <rect
        x="23.5"
        y="7.5"
        width="93"
        height="93"
        rx="46.5"
        stroke="rgba(255,255,255,0.2)"
        stroke-width="1.5" />
      <g filter="url(#filter0_ddi_1048_7373)">
        <rect
          x="25"
          y="9"
          width="90"
          height="90"
          rx="45"
          fill="rgba(100, 100, 100, 0.8)"
          shape-rendering="crispEdges"
        />  <!-- Darker surface -->
      </g>
      ${this.renderIcon()}
      <defs>
        <filter
          id="filter0_ddi_1048_7373"
          x="0"
          y="0"
          width="140"
          height="140"
          filterUnits="userSpaceOnUse"
          color-interpolation-filters="sRGB">
          <feFlood flood-opacity="0" result="BackgroundImageFix" />
          <feColorMatrix
            in="SourceAlpha"
            type="matrix"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
            result="hardAlpha" />
          <feOffset dy="2" />
          <feGaussianBlur stdDeviation="4" />
          <feComposite in2="hardAlpha" operator="out" />
          <feColorMatrix
            type="matrix"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.25 0" />
          <feBlend
            mode="normal"
            in2="BackgroundImageFix"
            result="effect1_dropShadow_1048_7373" />
          <feColorMatrix
            in="SourceAlpha"
            type="matrix"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
            result="hardAlpha" />
          <feOffset dy="16" />
          <feGaussianBlur stdDeviation="12.5" />
          <feComposite in2="hardAlpha" operator="out" />
          <feColorMatrix
            type="matrix"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.25 0" />
          <feBlend
            mode="normal"
            in2="effect1_dropShadow_1048_7373"
            result="effect2_dropShadow_1048_7373" />
          <feBlend
            mode="normal"
            in="SourceGraphic"
            in2="effect2_dropShadow_1048_7373"
            result="shape" />
          <feColorMatrix
            in="SourceAlpha"
            type="matrix"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
            result="hardAlpha" />
          <feOffset dy="3" />
          <feGaussianBlur stdDeviation="1.5" />
          <feComposite in2="hardAlpha" operator="arithmetic" k2="-1" k3="1" />
          <feColorMatrix
            type="matrix"
            values="0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 0.1 0" /> <!-- Slightly stronger inner shadow -->
          <feBlend
            mode="normal"
            in2="shape"
            result="effect3_innerShadow_1048_7373" />
        </filter>
      </defs>
    </svg>`;
  }

  override render() {
    return html`${this.renderSVG()}<div class="hitbox"></div>`;
  }
}

// PlayPauseButton
// -----------------------------------------------------------------------------

/** A button for toggling play/pause. */
@customElement('play-pause-button')
export class PlayPauseButton extends IconButton {
  @property({type: String}) playbackState: PlaybackState = 'stopped';

  static override styles = [
    IconButton.styles,
    css`
      .loader {
        stroke: #ffffff;
        stroke-width: 3;
        stroke-linecap: round;
        animation: spin linear 1s infinite;
        transform-origin: center;
        transform-box: fill-box;
      }
      @keyframes spin {
        from {
          transform: rotate(0deg);
        }
        to {
          transform: rotate(359deg);
        }
      }
    `,
  ];

  private renderPause() {
    return svg`<path
      d="M75.0037 69V39H83.7537V69H75.0037ZM56.2537 69V39H65.0037V69H56.2537Z"
      fill="#FEFEFE"
    />`;
  }

  private renderPlay() {
    return svg`<path d="M60 71.5V36.5L87.5 54L60 71.5Z" fill="#FEFEFE" />`;
  }

  private renderLoading() {
    return svg`<path shape-rendering="crispEdges" class="loader" d="M70,74.2L70,74.2c-10.7,0-19.5-8.7-19.5-19.5l0,0c0-10.7,8.7-19.5,19.5-19.5
            l0,0c10.7,0,19.5,8.7,19.5,19.5l0,0"/>`;
  }

  override renderIcon() {
    if (this.playbackState === 'playing') {
      return this.renderPause();
    } else if (this.playbackState === 'loading') {
      return this.renderLoading();
    } else {
      return this.renderPlay();
    }
  }
}

@customElement('reset-button')
export class ResetButton extends IconButton {
  private renderResetIcon() {
    return svg`<path fill="#fefefe" d="M71,77.1c-2.9,0-5.7-0.6-8.3-1.7s-4.8-2.6-6.7-4.5c-1.9-1.9-3.4-4.1-4.5-6.7c-1.1-2.6-1.7-5.3-1.7-8.3h4.7
      c0,4.6,1.6,8.5,4.8,11.7s7.1,4.8,11.7,4.8c4.6,0,8.5-1.6,11.7-4.8c3.2-3.2,4.8-7.1,4.8-11.7s-1.6-8.5-4.8-11.7
      c-3.2-3.2-7.1-4.8-11.7-4.8h-0.4l3.7,3.7L71,46.4L61.5,37l9.4-9.4l3.3,3.4l-3.7,3.7H71c2.9,0,5.7,0.6,8.3,1.7
      c2.6,1.1,4.8,2.6,6.7,4.5c1.9,1.9,3.4,4.1,4.5,6.7c1.1,2.6,1.7,5.3,1.7,8.3c0,2.9-0.6,5.7-1.7,8.3c-1.1,2.6-2.6,4.8-4.5,6.7
      s-4.1,3.4-6.7,4.5C76.7,76.5,73.9,77.1,71,77.1z"/>`;
  }

  override renderIcon() {
    return this.renderResetIcon();
  }
}

// AddPromptButton component
// -----------------------------------------------------------------------------
/** A button for adding a new prompt. */
@customElement('add-prompt-button')
export class AddPromptButton extends IconButton {
  private renderAddIcon() {
    return svg`<path d="M67 40 H73 V52 H85 V58 H73 V70 H67 V58 H55 V52 H67 Z" fill="#FEFEFE" />`;
  }

  override renderIcon() {
    return this.renderAddIcon();
  }
}

// Toast Message component
// -----------------------------------------------------------------------------

@customElement('toast-message')
class ToastMessage extends LitElement {
  static override styles = css`
    .toast {
      line-height: 1.6;
      position: fixed;
      top: 20px;
      left: 50%;
      transform: translateX(-50%);
      background-color: rgba(25, 25, 25, 0.75); /* More translucent dark */
      backdrop-filter: blur(15px); /* Increased blur */
      color: white;
      padding: 15px;
      border-radius: 12px; /* More expressive */
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 15px;
      min-width: 200px;
      max-width: 80vw;
      transition: transform 0.5s cubic-bezier(0.19, 1, 0.22, 1);
      z-index: 11;
      border: 1px solid rgba(255, 255, 255, 0.12); /* Slightly more visible border */
    }
    button {
      border-radius: 100px;
      aspect-ratio: 1;
      border: none;
      color: #000;
      cursor: pointer;
    }
    .toast:not(.showing) {
      transition-duration: 1s;
      transform: translate(-50%, -200%);
    }
  `;

  @property({type: String}) message = '';
  @property({type: Boolean}) showing = false;

  override render() {
    return html`<div class=${classMap({showing: this.showing, toast: true})}>
      <div class="message">${this.message}</div>
      <button @click=${this.hide}>✕</button>
    </div>`;
  }

  show(message: string) {
    this.showing = true;
    this.message = message;
  }

  hide() {
    this.showing = false;
  }
}

/** A single prompt input */
@customElement('prompt-controller')
class PromptController extends LitElement {
  static override styles = css`
    .prompt {
      position: relative;
      height: 100%;
      width: 100%;
      display: flex;
      flex-direction: column;
      align-items: center;
      box-sizing: border-box;
      overflow: hidden;
      background-color: rgba(60, 60, 60, 0.65); /* Slightly darker & more opaque */
      backdrop-filter: blur(20px); /* More pronounced blur */
      border-radius: 20px; /* Increased rounding */
      border: 1px solid rgba(255, 255, 255, 0.15); /* More visible border */
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3); /* Enhanced shadow */
    }
    .remove-button {
      position: absolute;
      /* Slightly adjusted positioning */
      top: 1.2vmin;
      left: 1.2vmin;
      background: #666;
      color: #fff;
      border: none;
      border-radius: 50%;
      width: 2.8vmin;
      height: 2.8vmin; 
      font-size: 1.8vmin;
      display: flex;
      align-items: center;
      justify-content: center;
      line-height: 2.8vmin;
      cursor: pointer;
      opacity: 0.5;
      transition: opacity 0.2s;
      z-index: 10;
    }
    .remove-button:hover {
      opacity: 1;
    }
    weight-slider {
      /* Calculate height: 100% of parent minus controls height and margin */
      max-height: calc(100% - 9vmin);
      flex: 1;
      min-height: 10vmin;
      width: 100%;
      box-sizing: border-box;
      overflow: hidden;
      margin: 2vmin 0 1vmin;
    }
    .controls {
      display: flex;
      flex-direction: column;
      flex-shrink: 0;
      align-items: center;
      gap: 0.2vmin;
      width: 100%;
      height: 8vmin;
      padding: 0 0.5vmin;
      box-sizing: border-box;
      margin-bottom: 1vmin;
    }
    #text {
      font-family: 'Google Sans', sans-serif;
      font-size: 1.8vmin;
      width: 100%;
      flex-grow: 1;
      max-height: 100%;
      padding: 0.4vmin;
      box-sizing: border-box;
      text-align: center;
      word-wrap: break-word;
      overflow-y: auto;
      border: none;
      outline: none;
      -webkit-font-smoothing: antialiased;
      color: #fff;
      scrollbar-width: thin;
      scrollbar-color: #666 #1a1a1a;
    }
    #text::-webkit-scrollbar {
      width: 6px;
    }
    #text::-webkit-scrollbar-track {
      background: #0009;
      border-radius: 3px;
    }
    #text::-webkit-scrollbar-thumb {
      background-color: #666;
      border-radius: 3px;
    }
    :host([filtered='true']) #text {
      background: #da2000;
    }

    @media (max-width: 600px) and (orientation: portrait) {
      .prompt {
        border-radius: 12px; /* Reduced rounding */
      }
      .remove-button {
        /* Ensure touch target is adequate */
        width: clamp(24px, 5vmin, 30px);
        height: clamp(24px, 5vmin, 30px);
        font-size: clamp(14px, 3vmin, 18px);
        line-height: clamp(24px, 5vmin, 30px); /* Center the 'x' */
        top: 0.8vmin;
        left: 0.8vmin;
      }
      weight-slider {
        max-height: calc(100% - 10.5vmin); /* Parent height - (new controls height + new controls margin-bottom) */
        margin: 1vmin 0 0.5vmin; /* New margins for weight-slider itself */
      }
      .controls {
        height: 10vmin; /* Adjusted for text readability */
        padding: 0 0.3vmin;
        margin-bottom: 0.5vmin;
        gap: 0.1vmin;
      }
      #text {
        font-size: clamp(12px, 2.2vmin, 14px); /* Adjusted for readability */
        padding: 0.3vmin;
      }
    }
  `;

  @property({type: String, reflect: true}) promptId = '';
  @property({type: String}) text = '';
  @property({type: Number}) weight = 0;
  @property({type: String}) color = '';

  @query('weight-slider') private weightInput!: WeightSlider;
  @query('#text') private textInput!: HTMLSpanElement;

  private handleTextKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      this.updateText();
      (e.target as HTMLElement).blur();
    }
  }

  private dispatchPromptChange() {
    this.dispatchEvent(
      new CustomEvent<Prompt>('prompt-changed', {
        detail: {
          promptId: this.promptId,
          text: this.text,
          weight: this.weight,
          color: this.color,
        },
      }),
    );
  }

  private updateText() {
    console.log('updateText');
    const newText = this.textInput.textContent?.trim();
    if (newText === '') {
      this.textInput.textContent = this.text;
      return;
    }
    this.text = newText;
    this.dispatchPromptChange();
  }

  private updateWeight() {
    this.weight = this.weightInput.value;
    this.dispatchPromptChange();
  }

  private dispatchPromptRemoved() {
    this.dispatchEvent(
      new CustomEvent<string>('prompt-removed', {
        detail: this.promptId,
        bubbles: true,
        composed: true,
      }),
    );
  }

  override render() {
    const classes = classMap({
      'prompt': true,
    });
    return html`<div class=${classes}>
      <button class="remove-button" @click=${this.dispatchPromptRemoved}
        >×</button
      >
      <weight-slider
        id="weight"
        value=${this.weight}
        color=${this.color}
        @input=${this.updateWeight}></weight-slider>
      <div class="controls">
        <span
          id="text"
          spellcheck="false"
          contenteditable="plaintext-only"
          @keydown=${this.handleTextKeyDown}
          @blur=${this.updateText}
          >${this.text}</span
        >
      </div>
    </div>`;
  }
}

/** A panel for managing real-time music generation settings. */
@customElement('settings-controller')
class SettingsController extends LitElement {
  static override styles = css`
    :host {
      display: block;
      padding: 2vmin;
      background-color: rgba(60, 60, 60, 0.65);
      backdrop-filter: blur(20px);
      color: #eee;
      box-sizing: border-box;
      border-radius: 20px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
      font-family: 'Google Sans', sans-serif;
      border: 1px solid rgba(255, 255, 255, 0.12); /* Slightly more visible border */
      box-shadow: 0 6px 18px rgba(0,0,0,0.25); /* Slightly stronger shadow */
      font-size: 1.5vmin;
      /* font-size: clamp(13px, 1.5vmin, 16px); /* Base font size for context */
      overflow-y: auto; /* Keep this for content scroll */
      scrollbar-width: thin;
      scrollbar-color: #666 #1a1a1a;
      transition: width 0.3s ease-out, max-height 0.3s ease-out;
    }
    :host([showadvanced]) {
      max-height: 40vmin;
    }
    :host::-webkit-scrollbar {
      width: 6px;
    }
    :host::-webkit-scrollbar-track {
      background: #1a1a1a;
      border-radius: 3px;
    }
    :host::-webkit-scrollbar-thumb {
      background-color: #666;
      border-radius: 3px;
    }
    .setting {
      margin-bottom: 0.5vmin;
      display: flex;
      flex-direction: column;
      gap: 0.5vmin;
    }
    label {
      font-weight: bold;
      display: flex;
      justify-content: space-between;
      align-items: center;
      white-space: nowrap;
      user-select: none;
    }
    label span:last-child {
      font-weight: normal;
      color: #ccc;
      min-width: 3em;
      text-align: right;
    }
    input[type='range'] {
      --track-bg: rgba(255,255,255,0.2); /* Lighter inactive track for contrast */
      --track-border-radius: 6px; /* Pill shape for fatter track */
      --thumb-size: 24px; /* Made thumb larger/fatter */
      --thumb-bg: #5200ff;
      --thumb-border-radius: 8px; /* Rounded rectangle, no longer a circle */
      --thumb-box-shadow: 0 1px 3px rgba(0,0,0,0.4); /* Softer shadow */
      --value-percent: 0%;
      -webkit-appearance: none;
      appearance: none;
      width: 100%;
      height: var(--thumb-size); /* Ensure space for thumb interaction */
      background: transparent;
      cursor: pointer;
      outline: none; /* Remove default outline */
      margin: 0.5vmin 0;
      border: none;
      padding: 0;
      vertical-align: middle;
    }
    input[type='range']::-webkit-slider-runnable-track {
      width: 100%;
      height: var(--track-height);
      cursor: pointer;
      border: none;
      background: linear-gradient(
        to right,
        var(--thumb-bg) var(--value-percent),
        var(--track-bg) var(--value-percent)
      );
      border-radius: var(--track-border-radius);
      transition: background-color 0.2s ease;
    }
    input[type='range']::-moz-range-track {
      width: 100%;
      height: var(--track-height);
      cursor: pointer;
      background: var(--track-bg);
      border-radius: var(--track-border-radius);
      border: none;
    }
    /* Firefox progress part */
    input[type='range']::-moz-range-progress {
        background-color: var(--thumb-bg);
        height: var(--track-height);
        border-radius: var(--track-border-radius);
    }
    input[type='range']::-webkit-slider-thumb {
      -webkit-appearance: none;
      appearance: none;
      height: var(--thumb-size);
      width: var(--thumb-size);
      background: var(--thumb-bg);
      border-radius: var(--thumb-border-radius);
      box-shadow: var(--thumb-box-shadow);
      cursor: pointer;
      margin-top: calc((var(--thumb-size) - var(--track-height)) / -2);
      transition: transform 0.2s cubic-bezier(0.4, 0, 0.2, 1),
                  box-shadow 0.2s cubic-bezier(0.4, 0, 0.2, 1);
    }
    input[type='range']::-moz-range-thumb {
      height: var(--thumb-size);
      width: var(--thumb-size);
      background: var(--thumb-bg);
      border-radius: var(--thumb-border-radius);
      box-shadow: var(--thumb-box-shadow);
      cursor: pointer;
      border: none;
      transition: transform 0.2s cubic-bezier(0.4, 0, 0.2, 1),
                  box-shadow 0.2s cubic-bezier(0.4, 0, 0.2, 1);
    }

    /* Hover/Focus/Active states for Thumb */
    input[type='range']:hover::-webkit-slider-thumb,
    input[type='range']:focus::-webkit-slider-thumb {
        transform: scale(1.1); /* Grow thumb */
        box-shadow: 0 0 0 6px rgba(82, 0, 255, 0.15), /* Halo effect (using --thumb-bg color) */
                    var(--thumb-box-shadow);
    }
    input[type='range']:hover::-moz-range-thumb,
    input[type='range']:focus::-moz-range-thumb {
        transform: scale(1.1);
        box-shadow: 0 0 0 6px rgba(82, 0, 255, 0.15),
                    var(--thumb-box-shadow);
    }
    input[type='range']:active::-webkit-slider-thumb,
    input[type='range']:active::-moz-range-thumb {
        transform: scale(1.2); /* Larger on active drag */
        box-shadow: 0 0 0 10px rgba(82, 0, 255, 0.25), /* Stronger halo */
                    0 2px 4px rgba(0,0,0,0.5); /* Stronger base shadow */
    }
    input[type='number'],
    input[type='text'],
    select {
      /* MD3 Inspired Styling */
      background-color: rgba(255, 255, 255, 0.08); /* Slightly more opaque base */
      color: #eee;
      border: 1.5px solid rgba(255, 255, 255, 0.2); /* Softer initial border */
      border-radius: 5px; /* justine custom rounding */
      padding: 0.8vmin 1.2vmin; /* More spacious padding */
      font-size: 1.5vmin;
      font-family: inherit;
      box-sizing: border-box;
      min-height: 3.8vmin; /* Consistent height */
      transition: background-color 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease;
      appearance: none; /* Remove default styling for custom look */
      -webkit-appearance: none;
      -moz-appearance: none;
    }
    input[type='number'] {
      width: 6em;
    }
    input[type='text'] {
      width: 100%;
      /* For browsers that support -moz-appearance: textfield for number inputs */
      -moz-appearance: textfield;
    }
    input[type='text']::placeholder {
      color: #888;
    }

    input[type='number']:hover,
    input[type='text']:hover,
    select:hover {
      background-color: rgba(255, 255, 255, 0.12); /* Lighten on hover */
      border-color: rgba(255, 255, 255, 0.4);
    }

    input[type='number']:focus,
    input[type='text']:focus,
    select:focus {
      outline: none;
      background-color: rgba(255, 255, 255, 0.1); /* Optional: subtle bg change on focus */
      border: 2px solid var(--thumb-bg); /* Use theme accent color for border */
      box-shadow: 0 0 0 3px rgba(82, 0, 255, 0.25); /* MD3 style focus ring/glow */
      /* Adjust padding to maintain consistent inner size due to border change */
      padding: calc(0.8vmin - 0.5px) calc(1.2vmin - 0.5px);
    }
    select {
      width: 100%;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='%23eeeeee'%3E%3Cpath d='M8 11L3 6h10z'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: right 1vmin center;
      background-size: 1.5vmin;
      padding-right: 3.5vmin; /* Space for the arrow, adjust padding calc if needed */
    }
    select option {
      background-color: #3a3a3a; /* Options typically not translucent for readability */
      color: #eee;
    }
    .checkbox-setting {
      flex-direction: row;
      align-items: center;
      gap: 1vmin;
    }
    input[type='checkbox'] {
      cursor: pointer;
      accent-color: var(--thumb-bg); /* Use theme accent color */
      width: 1.8vmin; /* MD3 standard size */
      height: 1.8vmin;
      margin-right: 0.8vmin; /* More space next to label */
      vertical-align: middle; /* Better alignment with text */
    }
    .checkbox-setting label {
        display: inline-flex; /* Helps align checkbox and text */
        align-items: center;
        cursor: pointer; /* Make the label clickable for the checkbox */
        transition: color 0.2s ease;
    }
    .checkbox-setting label:hover {
        color: #fff; /* Slightly brighten label text on hover */
    }
    .core-settings-row {
      display: flex;
      flex-direction: row;
      flex-wrap: wrap;
      gap: 4vmin; /* Gap between items within the core settings row */
      margin-bottom: 1vmin; /* Default bottom margin for the core settings row */
      transition: margin-bottom 0.3s ease-out; /* Smooth transition for margin changes */
      justify-content: space-evenly;
    }
    .core-settings-row .setting {
      min-width: 16vmin;
    }
    .core-settings-row label span:last-child {
      min-width: 2.5em;
    }
    .advanced-toggle {
      cursor: pointer;
      margin: 2vmin 0 1vmin 0;
      color: #aaa;
      text-decoration: underline;
      user-select: none;
      font-size: 1.4vmin;
      width: fit-content;
      transition: margin 0.3s ease-out; /* Smooth transition for margin changes */
    }
    .advanced-toggle:hover {
      color: #eee;
    }
    .advanced-settings {
      display: none; /* Hidden by default */
      grid-template-columns: repeat(auto-fit, minmax(10vmin, 1fr));
      overflow: hidden; /* Still useful for content clipping when visible */
      /* Transitions removed */
    }
    .advanced-settings.visible {
      display: grid; /* Become a grid when visible */
      grid-template-rows: 1fr;
      gap: 3vmin;
      opacity: 1;
      pointer-events: auto;
    }
    hr.divider {
      display: none; /* Hidden by default */
      border: none;
      border-top: 1px solid rgba(255,255,255,0.2); /* Softer, MD3-style divider */
      width: 100%;
      /* Transitions and related properties removed */
    }
    :host([showadvanced]) hr.divider {
      display: block; /* Show when advanced settings are active */
      margin: 2vmin 0; /* Restore original margins */
    }
    :host(:not([showadvanced])) .core-settings-row {
      margin-bottom: 0.25vmin; /* Drastically reduce bottom margin when advanced settings are hidden */
    }
    :host(:not([showadvanced])) .advanced-toggle {
      margin-top: 0.25vmin; /* Minimal top margin when collapsed */
      margin-bottom: 0.25vmin; /* Minimal bottom margin when collapsed */
    }
    .auto-row {
      display: flex;
      align-items: center;
      gap: 0.5vmin;
    }
    .setting[auto='true'] input[type='range'] {
      pointer-events: none;
      filter: grayscale(100%);
    }
    .auto-row span {
      margin-left: auto;
    }
    .auto-row label {
      cursor: pointer;
    }
    .auto-row input[type='checkbox'] {
      cursor: pointer;
      margin: 0;
    }

    /* Apply clamp to font sizes for better responsiveness */
    :host { font-size: clamp(13px, 1.5vmin, 16px); }
    label { font-size: clamp(12px, 1.5vmin, 15px); }
    label span:last-child { font-size: clamp(11px, 1.4vmin, 14px); }
    input[type='number'], input[type='text'], select { font-size: clamp(12px, 1.5vmin, 15px); }
    .advanced-toggle { font-size: clamp(11px, 1.4vmin, 14px); }

    @media (max-width: 600px) and (orientation: portrait) {
      :host {
        padding: 1vmin; /* Reduced padding */
        /* font-size clamp is already applied above, can adjust if needed for mobile specifically */
      }

      :host([showadvanced]) {
        max-height: 45vh; /* Further reduced max-height for advanced settings on mobile */
      }

      .core-settings-row {
        gap: 1.5vmin; /* Further reduced gap */
        flex-direction: column;
        align-items: stretch;
      }
      .core-settings-row .setting {
        min-width: unset;
        width: 100%;
      }

      .advanced-toggle {
        /* font-size clamp applied above */
        margin: 1.2vmin auto; /* Reduced margin, centered */
      }
      :host(:not([showadvanced])) .advanced-toggle {
        margin-top: 0.5vmin;
        margin-bottom: 0.5vmin;
      }

      .advanced-settings.visible {
        grid-template-columns: 1fr; /* Single column */
        gap: 1vmin; /* Further reduced gap */
      }
      .advanced-settings .setting {
         width: 100%;
      }

      input[type='range'] {
        --track-height: 10px; /* Adjusted fatter track for mobile */
        --track-border-radius: 5px; /* Pill shape for mobile track */
        --thumb-size: 20px; /* Adjusted larger thumb for mobile */
        --thumb-border-radius: 6px; /* Rounded rectangle thumb for mobile */
      }

      input[type='number'],
      input[type='text'],
      select {
        /* font-size clamp applied above */
        padding: 1vmin 1.3vmin; /* Reduced padding */
        min-height: 4.8vmin; /* Slightly reduced min-height */
      }
      input[type='number'] { width: 100%; }
      select { background-size: 2vmin; padding-right: 4.5vmin; }

      input[type='checkbox'] { width: 2.3vmin; height: 2.3vmin; } /* Slightly reduced size */
      .checkbox-setting label { /* font-size clamp applied via general label style */ }
    }
  `;

  private readonly defaultConfig = {
    temperature: 1.1,
    topK: 40,
    guidance: 4.0,
  };

  @state() private config: LiveMusicGenerationConfig = this.defaultConfig;

  @state() showAdvanced = false;

  @state() autoDensity = true;

  @state() lastDefinedDensity: number;

  @state() autoBrightness = true;

  @state() lastDefinedBrightness: number;

  public resetToDefaults() {
    this.config = this.defaultConfig;
    this.autoDensity = true;
    this.lastDefinedDensity = undefined;
    this.autoBrightness = true;
    this.lastDefinedBrightness = undefined;
    this.dispatchSettingsChange();
  }

  private updateSliderBackground(inputEl: HTMLInputElement) {
    if (inputEl.type !== 'range') {
      return;
    }
    const min = Number(inputEl.min) || 0;
    const max = Number(inputEl.max) || 100;
    const value = Number(inputEl.value);
    const percentage = ((value - min) / (max - min)) * 100;
    inputEl.style.setProperty('--value-percent', `${percentage}%`);
  }

  private handleInputChange(e: Event) {
    const target = e.target as HTMLInputElement;
    const key = target.id as
      | keyof LiveMusicGenerationConfig
      | 'auto-density'
      | 'auto-brightness';
    let value: string | number | boolean | undefined = target.value;

    if (target.type === 'number' || target.type === 'range') {
      value = target.value === '' ? undefined : Number(target.value);
      // Update slider background if it's a range input before handling the value change.
      if (target.type === 'range') {
        this.updateSliderBackground(target);
      }
    } else if (target.type === 'checkbox') {
      value = target.checked;
    } else if (target.type === 'select-one') {
      const selectElement = target as HTMLSelectElement;
      if (selectElement.options[selectElement.selectedIndex]?.disabled) {
        value = undefined;
      } else {
        value = target.value;
      }
    }

    const newConfig = {
      ...this.config,
      [key]: value,
    };

    if (newConfig.density !== undefined) {
      this.lastDefinedDensity = newConfig.density;
      console.log(this.lastDefinedDensity);
    }

    if (newConfig.brightness !== undefined) {
      this.lastDefinedBrightness = newConfig.brightness;
    }

    if (key === 'auto-density') {
      this.autoDensity = Boolean(value);
      newConfig.density = this.autoDensity
        ? undefined
        : this.lastDefinedDensity;
    } else if (key === 'auto-brightness') {
      this.autoBrightness = Boolean(value);
      newConfig.brightness = this.autoBrightness
        ? undefined
        : this.lastDefinedBrightness;
    }

    this.config = newConfig;
    this.dispatchSettingsChange();
  }

  override updated(changedProperties: Map<string | symbol, unknown>) {
    super.updated(changedProperties);
    if (changedProperties.has('config')) {
      this.shadowRoot
        ?.querySelectorAll<HTMLInputElement>('input[type="range"]')
        .forEach((slider: HTMLInputElement) => {
          const configValue =
            this.config[slider.id as keyof LiveMusicGenerationConfig];
          if (typeof configValue === 'number') {
            slider.value = String(configValue);
          } else if (slider.id === 'density' || slider.id === 'brightness') {
            // Handle potentially undefined density/brightness with default for background
            slider.value = String(configValue ?? 0.5);
          }
          this.updateSliderBackground(slider);
        });
    }
  }

  private dispatchSettingsChange() {
    this.dispatchEvent(
      new CustomEvent<LiveMusicGenerationConfig>('settings-changed', {
        detail: this.config,
        bubbles: true,
        composed: true,
      }),
    );
  }

  private toggleAdvancedSettings() {
    this.showAdvanced = !this.showAdvanced;
  }

  override render() {
    const cfg = this.config;
    const advancedClasses = classMap({
      'advanced-settings': true,
      'visible': this.showAdvanced,
    });
    const scaleMap = new Map<string, string>([
      ['Auto', 'SCALE_UNSPECIFIED'],
      ['C Major / A Minor', 'C_MAJOR_A_MINOR'],
      ['C# Major / A# Minor', 'D_FLAT_MAJOR_B_FLAT_MINOR'],
      ['D Major / B Minor', 'D_MAJOR_B_MINOR'],
      ['D# Major / C Minor', 'E_FLAT_MAJOR_C_MINOR'],
      ['E Major / C# Minor', 'E_MAJOR_D_FLAT_MINOR'],
      ['F Major / D Minor', 'F_MAJOR_D_MINOR'],
      ['F# Major / D# Minor', 'G_FLAT_MAJOR_E_FLAT_MINOR'],
      ['G Major / E Minor', 'G_MAJOR_E_MINOR'],
      ['G# Major / F Minor', 'A_FLAT_MAJOR_F_MINOR'],
      ['A Major / F# Minor', 'A_MAJOR_G_FLAT_MINOR'],
      ['A# Major / G Minor', 'B_FLAT_MAJOR_G_MINOR'],
      ['B Major / G# Minor', 'B_MAJOR_A_FLAT_MINOR'],
    ]);

    return html`
      <div class="core-settings-row">
        <div class="setting">
          <label for="temperature"
            >Temperature<span>${cfg.temperature!.toFixed(1)}</span></label
          >
          <input
            type="range"
            id="temperature"
            min="0"
            max="3"
            step="0.1"
            .value=${cfg.temperature!.toString()}
            @input=${this.handleInputChange} />
        </div>
        <div class="setting">
          <label for="guidance"
            >Guidance<span>${cfg.guidance!.toFixed(1)}</span></label
          >
          <input
            type="range"
            id="guidance"
            min="0"
            max="6"
            step="0.1"
            .value=${cfg.guidance!.toString()}
            @input=${this.handleInputChange} />
        </div>
        <div class="setting">
          <label for="topK">Top K<span>${cfg.topK}</span></label>
          <input
            type="range"
            id="topK"
            min="1"
            max="100"
            step="1"
            .value=${cfg.topK!.toString()}
            @input=${this.handleInputChange} />
        </div>
      </div>
      <hr class="divider" />
      <div class=${advancedClasses}>
        <div class="setting">
          <label for="seed">Seed</label>
          <input
            type="number"
            id="seed"
            .value=${cfg.seed ?? ''}
            @input=${this.handleInputChange}
            placeholder="Auto" />
        </div>
        <div class="setting">
          <label for="bpm">BPM</label>
          <input
            type="number"
            id="bpm"
            min="60"
            max="180"
            .value=${cfg.bpm ?? ''}
            @input=${this.handleInputChange}
            placeholder="Auto" />
        </div>
        <div class="setting" auto=${this.autoDensity}>
          <label for="density">Density</label>
          <input
            type="range"
            id="density"
            min="0"
            max="1"
            step="0.05"
            .value=${this.lastDefinedDensity}
            @input=${this.handleInputChange} />
          <div class="auto-row">
            <input
              type="checkbox"
              id="auto-density"
              .checked=${this.autoDensity}
              @input=${this.handleInputChange} />
            <label for="auto-density">Auto</label>
            <span>${(this.lastDefinedDensity ?? 0.5).toFixed(2)}</span>
          </div>
        </div>
        <div class="setting" auto=${this.autoBrightness}>
          <label for="brightness">Brightness</label>
          <input
            type="range"
            id="brightness"
            min="0"
            max="1"
            step="0.05"
            .value=${this.lastDefinedBrightness}
            @input=${this.handleInputChange} />
          <div class="auto-row">
            <input
              type="checkbox"
              id="auto-brightness"
              .checked=${this.autoBrightness}
              @input=${this.handleInputChange} />
            <label for="auto-brightness">Auto</label>
            <span>${(this.lastDefinedBrightness ?? 0.5).toFixed(2)}</span>
          </div>
        </div>
        <div class="setting">
          <label for="scale">Scale</label>
          <select
            id="scale"
            .value=${cfg.scale || 'SCALE_UNSPECIFIED'}
            @change=${this.handleInputChange}>
            <option value="" disabled selected>Select Scale</option>
            ${[...scaleMap.entries()].map(
              ([displayName, enumValue]) =>
                html`<option value=${enumValue}>${displayName}</option>`,
            )}
          </select>
        </div>
        <div class="setting">
          <div class="setting checkbox-setting">
            <input
              type="checkbox"
              id="muteBass"
              .checked=${!!cfg.muteBass}
              @change=${this.handleInputChange} />
            <label for="muteBass" style="font-weight: normal;">Mute Bass</label>
          </div>
          <div class="setting checkbox-setting">
            <input
              type="checkbox"
              id="muteDrums"
              .checked=${!!cfg.muteDrums}
              @change=${this.handleInputChange} />
            <label for="muteDrums" style="font-weight: normal;"
              >Mute Drums</label
            >
          </div>
          <div class="setting checkbox-setting">
            <input
              type="checkbox"
              id="onlyBassAndDrums"
              .checked=${!!cfg.onlyBassAndDrums}
              @change=${this.handleInputChange} />
            <label for="onlyBassAndDrums" style="font-weight: normal;"
              >Only Bass & Drums</label
            >
          </div>
        </div>
      </div>
      <div class="advanced-toggle" @click=${this.toggleAdvancedSettings}>
        ${this.showAdvanced ? 'Hide' : 'Show'} Advanced Settings
      </div>
    `;
  }
}

/** Component for the PromptDJ UI. */
@customElement('prompt-dj')
class PromptDj extends LitElement {
  static override styles = css`
    :host {
      height: 100%;
      width: 100%;
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      box-sizing: border-box;
      /* background-color removed, #background will handle it */
      padding: 2vmin;
      position: relative;
      font-family: 'Google Sans', 'Helvetica Neue', Helvetica, Arial, sans-serif;
    }
    @keyframes rotateBackground {
      from {
        transform: rotate(0deg);
      }
      to {
        transform: rotate(360deg);
      }
    }
    #background {
      position: absolute;
      height: 100%;
      width: 100%;
      z-index: -1;
      background-color: #111; /* Base dark color */
      /* animation: rotateBackground 120s linear infinite; - Rotation removed */
      transform-origin: center center; /* Ensure rotation is around the center */
    }
    .prompts-area {
      display: flex;
      align-items: flex-end;
      justify-content: center;
      flex: 4;
      width: 100%;
      margin-top: 2vmin;
      gap: 2vmin;
    }
    #prompts-container {
      display: flex;
      flex-direction: row;
      align-items: flex-end;
      flex-shrink: 1;
      height: 100%;
      gap: 2vmin;
      margin-left: 10vmin;
      padding: 1vmin;
      overflow-x: auto;
      scrollbar-width: thin;
      scrollbar-color: #666 #1a1a1a;
    }
    #prompts-container::-webkit-scrollbar {
      height: 8px;
    }
    #prompts-container::-webkit-scrollbar-track {
      background: #111;
      border-radius: 4px;
    }
    #prompts-container::-webkit-scrollbar-thumb {
      background-color: #666;
      border-radius: 4px;
    }
    #prompts-container::-webkit-scrollbar-thumb:hover {
      background-color: #777;
    }
    /* Add pseudo-elements for centering while keeping elements visible when scrolling */
    #prompts-container::before,
    #prompts-container::after {
      content: '';
      flex: 1;
      min-width: 0.5vmin;
    }
    .add-prompt-button-container {
      display: flex;
      align-items: flex-end;
      height: 100%;
      flex-shrink: 0;
    }
    #settings-container {
      flex: 1;
      margin: 2vmin 0 1vmin 0;
    }
    .playback-container {
      display: flex;
      justify-content: center;
      align-items: center;
      flex-shrink: 0;
    }
    .footer-container {
      width: 100%;
      display: flex;
      justify-content: center;
      align-items: center;
      gap: 1.5vmin; /* Space between GitHub link and AI Studio credit */
      padding: 1vmin 0;
      flex-shrink: 0;
    }
    play-pause-button,
    add-prompt-button,
    reset-button {
      width: 12vmin;
      flex-shrink: 0;
    }
    prompt-controller {
      height: 100%;
      max-height: 80vmin;
      min-width: 14vmin;
      max-width: 16vmin;
      flex: 1;
    }
    .github-link {
      display: inline-flex; /* For aligning icon and text */
      align-items: center;
      gap: 0.5vmin; /* Space between icon and text */
      font-family: 'Google Sans', 'Helvetica Neue', Helvetica, Arial, sans-serif; /* Added sans-serif font stack */
      font-size: 1.8vmin; /* Increased font size */
      color: #777;
      text-decoration: none;
    }
    .github-link:hover {
      color: #aaa;
    }
    .github-link svg {
      width: 2vmin; /* Adjusted icon size */
      height: 2vmin;
      fill: currentColor; /* Icon color matches text color */
      vertical-align: middle; /* Helps with alignment */
    }
    .ai-studio-credit {
      display: inline-flex;
      align-items: center;
      gap: 0.5vmin;
      font-size: 1.8vmin;
      font-family: 'Google Sans', 'Helvetica Neue', Helvetica, Arial, sans-serif; /* Added sans-serif font stack */
      color: #777;
      text-decoration: none; /* Style as a link */
    }
    .footer-separator {
      color: #777;
      font-size: 1.8vmin;
      font-family: 'Google Sans', 'Helvetica Neue', Helvetica, Arial, sans-serif;
      user-select: none; /* Prevent selecting the separator */
    }
    .ai-studio-credit:hover {
      color: #aaa; /* Hover effect like GitHub link */
    }

    @media (max-width: 600px) and (orientation: portrait) {
      :host {
        padding: 1vmin; /* Reduced padding */
        /* Prevent potential scrollbars if any large scaled element tries to break bounds */
        overflow: hidden; 
      }
      #background {
        background-image: none !important; /* Remove complex radial gradients on mobile */
      }
      .prompts-area {
        margin-top: 1vmin; /* Reduced margin */
        gap: 1vmin; /* Reduce gap between prompts-container and add-button */
        flex: 2; /* Significantly reduced flex to make prompts area more compact */
      }
      #prompts-container {
        margin-left: 1vmin; /* Drastically reduce left margin */
        padding: 0.5vmin; /* Reduced padding */
        gap: 1vmin; /* Reduced gap between prompt-controllers */
      }
      prompt-controller {
        min-width: 20vmin; /* Wider for better touch/text */
        max-width: 24vmin;
        max-height: 30vmin; /* Further reduced max height for more compactness */
      }
      play-pause-button,
      add-prompt-button,
      reset-button {
        width: 16vmin; /* Adjusted for touch, still compact */
      }
      .footer-container {
        gap: 1vmin; /* Reduced gap */
        padding: 0.5vmin 0;
      }
      .github-link, .ai-studio-credit, .footer-separator {
        font-size: clamp(11px, 2.5vmin, 13px); /* Smaller font for footer */
      }
      .github-link svg {
        width: clamp(14px, 2.2vmin, 16px); /* Adjust icon size */
        height: clamp(14px, 2.2vmin, 16px);
      }
      #settings-container {
        margin: 1vmin 0; /* Reduced margin */
        flex: 1.5; /* Adjusted from 1, to give settings a bit more relative space */
      }
    }
  `;

  @property({
    type: Object,
    attribute: false,
  })
  private prompts: Map<string, Prompt>;
  private nextPromptId: number; // Monotonically increasing ID for new prompts
  private session: LiveMusicSession;
  private readonly sampleRate = 48000;
  private audioContext = new (window.AudioContext || window.webkitAudioContext)(
    {sampleRate: this.sampleRate},
  );
  private outputNode: GainNode = this.audioContext.createGain();
  private nextStartTime = 0;
  private readonly bufferTime = 2; // adds an audio buffer in case of netowrk latency
  @state() private playbackState: PlaybackState = 'stopped';
  @property({type: Object})
  private filteredPrompts = new Set<string>();
  private connectionError = true;

  @query('play-pause-button') private playPauseButton!: PlayPauseButton;
  @query('toast-message') private toastMessage!: ToastMessage;
  @query('settings-controller') private settingsController!: SettingsController;

  constructor(prompts: Map<string, Prompt>) {
    super();
    this.prompts = prompts;
    this.nextPromptId = this.prompts.size;
    this.outputNode.connect(this.audioContext.destination);
  }

  override async firstUpdated() {
    await this.connectToSession();
    this.setSessionPrompts();

    // Programmatically add Vercel Web Analytics and Speed Insights scripts
    // Vercel Web Analytics (for window.va)
    if (!document.head.querySelector('script[data-vercel-va-init]')) { // Check to prevent multiple additions
      const vaScript = document.createElement('script');
      vaScript.setAttribute('data-vercel-va-init', 'true'); // Mark as initialized
      vaScript.text = `window.va = window.va || function () { (window.vaq = window.vaq || []).push(arguments); };`;
      document.head.appendChild(vaScript);
    }

    // Vercel Speed Insights
    // Check if a script with this specific src already exists in head or body
    if (!document.querySelector('script[src="/_vercel/insights/script.js"]')) {
      const insightsScript = document.createElement('script');
      insightsScript.defer = true;
      insightsScript.src = '/_vercel/insights/script.js';
      // Vercel docs often show this in body, but head with defer is also fine.
      document.body.appendChild(insightsScript); // Or document.head.appendChild(insightsScript);
    }
  }

  private async connectToSession() {
    this.session = await ai.live.music.connect({
      model: model,
      callbacks: {
        onmessage: async (e: LiveMusicServerMessage) => {
          console.log('Received message from the server: %s\n');
          console.log(e);
          if (e.setupComplete) {
            this.connectionError = false;
          }
          if (e.filteredPrompt) {
            this.filteredPrompts = new Set([
              ...this.filteredPrompts,
              e.filteredPrompt.text,
            ]);
            this.toastMessage.show(e.filteredPrompt.filteredReason);
          }
          if (e.serverContent?.audioChunks !== undefined) {
            if (
              this.playbackState === 'paused' ||
              this.playbackState === 'stopped'
            )
              return;
            const audioBuffer = await decodeAudioData(
              decode(e.serverContent?.audioChunks[0].data),
              this.audioContext,
              48000,
              2,
            );
            const source = this.audioContext.createBufferSource();
            source.buffer = audioBuffer;
            source.connect(this.outputNode);
            if (this.nextStartTime === 0) {
              this.nextStartTime =
                this.audioContext.currentTime + this.bufferTime;
              setTimeout(() => {
                this.playbackState = 'playing';
              }, this.bufferTime * 1000);
            }

            if (this.nextStartTime < this.audioContext.currentTime) {
              console.log('under run');
              this.playbackState = 'loading';
              this.nextStartTime = 0;
              return;
            }
            source.start(this.nextStartTime);
            this.nextStartTime += audioBuffer.duration;
          }
        },
        onerror: (e: ErrorEvent) => {
          console.log('Error occurred: %s\n', JSON.stringify(e));
          this.connectionError = true;
          this.stopAudio();
          this.toastMessage.show('Connection error, please restart audio.');
        },
        onclose: (e: CloseEvent) => {
          console.log('Connection closed.');
          this.connectionError = true;
          this.stopAudio();
          this.toastMessage.show('Connection error, please restart audio.');
        },
      },
    });
  }

  private setSessionPrompts = throttle(async () => {
    const promptsToSend = Array.from(this.prompts.values()).filter((p) => {
      return !this.filteredPrompts.has(p.text) && p.weight !== 0;
    });
    try {
      await this.session.setWeightedPrompts({
        weightedPrompts: promptsToSend,
      });
    } catch (e) {
      this.toastMessage.show(e.message);
      this.pauseAudio();
    }
  }, 200);

  private dispatchPromptsChange() {
    this.dispatchEvent(
      new CustomEvent('prompts-changed', {detail: this.prompts}),
    );
  }

  private handlePromptChanged(e: CustomEvent<Prompt>) {
    const {promptId, text, weight} = e.detail;
    const prompt = this.prompts.get(promptId);

    if (!prompt) {
      console.error('prompt not found', promptId);
      return;
    }

    prompt.text = text;
    prompt.weight = weight;

    const newPrompts = new Map(this.prompts);
    newPrompts.set(promptId, prompt);

    this.prompts = newPrompts;

    this.setSessionPrompts();

    this.requestUpdate();
    this.dispatchPromptsChange();
  }

  /** Generates radial gradients for each prompt based on weight and color. */
  private makeBackground() {
    const clamp01 = (v: number) => Math.min(Math.max(v, 0), 1);

    const MAX_WEIGHT = 0.5;
    const MAX_ALPHA = 0.6;

    const bg: string[] = [];

    [...this.prompts.values()].forEach((p, i) => {
      const alphaPct = clamp01(p.weight / MAX_WEIGHT) * MAX_ALPHA;
      const alpha = Math.round(alphaPct * 0xff)
        .toString(16)
        .padStart(2, '0');

      const stop = p.weight / 2;
      const x = (i % 4) / 3;
      const y = Math.floor(i / 4) / 3;
      const s = `radial-gradient(circle at ${x * 100}% ${y * 100}%, ${p.color}${alpha} 0px, ${p.color}00 ${stop * 100}%)`;

      bg.push(s);
    });

    return bg.join(', ');
  }

  private async handlePlayPause() {
    if (this.playbackState === 'playing') {
      this.pauseAudio();
    } else if (
      this.playbackState === 'paused' ||
      this.playbackState === 'stopped'
    ) {
      if (this.connectionError) {
        await this.connectToSession();
        this.setSessionPrompts();
      }
      this.loadAudio();
    } else if (this.playbackState === 'loading') {
      this.stopAudio();
    }
    console.debug('handlePlayPause');
  }

  private pauseAudio() {
    this.session.pause();
    this.playbackState = 'paused';
    this.outputNode.gain.setValueAtTime(1, this.audioContext.currentTime);
    this.outputNode.gain.linearRampToValueAtTime(
      0,
      this.audioContext.currentTime + 0.1,
    );
    this.nextStartTime = 0;
    this.outputNode = this.audioContext.createGain();
    this.outputNode.connect(this.audioContext.destination);
  }

  private loadAudio() {
    this.audioContext.resume();
    this.session.play();
    this.playbackState = 'loading';
    this.outputNode.gain.setValueAtTime(0, this.audioContext.currentTime);
    this.outputNode.gain.linearRampToValueAtTime(
      1,
      this.audioContext.currentTime + 0.1,
    );
  }

  private stopAudio() {
    this.session.stop();
    this.playbackState = 'stopped';
    this.outputNode.gain.setValueAtTime(0, this.audioContext.currentTime);
    this.outputNode.gain.linearRampToValueAtTime(
      1,
      this.audioContext.currentTime + 0.1,
    );
    this.nextStartTime = 0;
  }

  private async handleAddPrompt() {
    const newPromptId = `prompt-${this.nextPromptId++}`;
    const usedColors = [...this.prompts.values()].map((p) => p.color);
    const newPrompt: Prompt = {
      promptId: newPromptId,
      text: 'New Prompt', // Default text
      weight: 0,
      color: getUnusedRandomColor(usedColors),
    };
    const newPrompts = new Map(this.prompts);
    newPrompts.set(newPromptId, newPrompt);
    this.prompts = newPrompts;

    await this.setSessionPrompts();

    // Wait for the component to update and render the new prompt.
    // Do not dispatch the prompt change event until the user has edited the prompt text.
    await this.updateComplete;

    // Find the newly added prompt controller element
    const newPromptElement = this.renderRoot.querySelector<PromptController>(
      `prompt-controller[promptId="${newPromptId}"]`,
    );
    if (newPromptElement) {
      // Scroll the prompts container to the new prompt element
      newPromptElement.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
        inline: 'end',
      });

      // Select the new prompt text
      const textSpan =
        newPromptElement.shadowRoot?.querySelector<HTMLSpanElement>('#text');
      if (textSpan) {
        textSpan.focus();
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(textSpan);
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
    }
  }

  private handlePromptRemoved(e: CustomEvent<string>) {
    e.stopPropagation();
    const promptIdToRemove = e.detail;
    if (this.prompts.has(promptIdToRemove)) {
      this.prompts.delete(promptIdToRemove);
      const newPrompts = new Map(this.prompts);
      this.prompts = newPrompts;
      this.setSessionPrompts();
      this.dispatchPromptsChange();
    } else {
      console.warn(
        `Attempted to remove non-existent prompt ID: ${promptIdToRemove}`,
      );
    }
  }

  // Handle scrolling X-axis the prompts container.
  private handlePromptsContainerWheel(e: WheelEvent) {
    const container = e.currentTarget as HTMLElement;
    if (e.deltaX !== 0) {
      // Prevent the default browser action (like page back/forward)
      e.preventDefault();
      container.scrollLeft += e.deltaX;
    }
  }

  private updateSettings = throttle(
    async (e: CustomEvent<LiveMusicGenerationConfig>) => {
      await this.session?.setMusicGenerationConfig({
        musicGenerationConfig: e.detail,
      });
    },
    200,
  );

  private async handleReset() {
    if (this.connectionError) {
      await this.connectToSession();
      this.setSessionPrompts();
    }
    this.pauseAudio();
    this.session.resetContext();
    this.settingsController.resetToDefaults();
    this.session?.setMusicGenerationConfig({
      musicGenerationConfig: {},
    });
    setTimeout(this.loadAudio.bind(this), 100);
  }

  override render() {
    const bg = styleMap({
      backgroundImage: this.makeBackground(),
    });
    return html`<div id="background" style=${bg}></div>
      <div class="prompts-area">
        <div
          id="prompts-container"
          @prompt-removed=${this.handlePromptRemoved}
          @wheel=${this.handlePromptsContainerWheel}>
          ${this.renderPrompts()}
        </div>
        <div class="add-prompt-button-container">
          <add-prompt-button @click=${this.handleAddPrompt}></add-prompt-button>
        </div>
      </div>
      <div id="settings-container">
        <settings-controller
          @settings-changed=${this.updateSettings}></settings-controller>
      </div>
      <div class="playback-container">
        <play-pause-button
          @click=${this.handlePlayPause}
          .playbackState=${this.playbackState}></play-pause-button>
        <reset-button @click=${this.handleReset}></reset-button>
      </div>
      <div class="footer-container">
        <a class="github-link" href="https://github.com/justinecabel" target="_blank" rel="noopener noreferrer">
          <svg viewBox="0 0 16 16" version="1.1" aria-hidden="true">
            <path fill-rule="evenodd" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"></path>
          </svg>
          Justine
        </a>
        <span class="footer-separator">|</span>
        <a class="ai-studio-credit" href="https://aistudio.google.com/apps/bundled/promptdj?showPreview=true" target="_blank" rel="noopener noreferrer">
          From Google AI Studio
        </a>
        
      </div>
      <toast-message></toast-message>
      `;
  }

  private renderPrompts() {
    return [...this.prompts.values()].map((prompt) => {
      return html`<prompt-controller
        .promptId=${prompt.promptId}
        filtered=${this.filteredPrompts.has(prompt.text)}
        .text=${prompt.text}
        .weight=${prompt.weight}
        .color=${prompt.color}
        @prompt-changed=${this.handlePromptChanged}>
      </prompt-controller>`;
    });
  }
}

function gen(parent: HTMLElement) {
  const initialPrompts = getStoredPrompts();

  const pdj = new PromptDj(initialPrompts);
  parent.appendChild(pdj);
}

function getStoredPrompts(): Map<string, Prompt> {
  const {localStorage} = window;
  const storedPrompts = localStorage.getItem('prompts');

  if (storedPrompts) {
    try {
      const prompts = JSON.parse(storedPrompts) as Prompt[];
      console.log('Loading stored prompts', prompts);
      return new Map(prompts.map((prompt) => [prompt.promptId, prompt]));
    } catch (e) {
      console.error('Failed to parse stored prompts', e);
    }
  }

  console.log('No stored prompts, creating prompt presets');

  const numDefaultPrompts = Math.min(4, PROMPT_TEXT_PRESETS.length);
  const shuffledPresetTexts = [...PROMPT_TEXT_PRESETS].sort(
    () => Math.random() - 0.5,
  );
  const defaultPrompts: Prompt[] = [];
  const usedColors: string[] = [];
  for (let i = 0; i < numDefaultPrompts; i++) {
    const text = shuffledPresetTexts[i];
    const color = getUnusedRandomColor(usedColors);
    usedColors.push(color);
    defaultPrompts.push({
      promptId: `prompt-${i}`,
      text,
      weight: 0,
      color,
    });
  }
  // Randomly select up to 2 prompts to set their weight to 1.
  const promptsToActivate = [...defaultPrompts].sort(() => Math.random() - 0.5);
  const numToActivate = Math.min(2, defaultPrompts.length);
  for (let i = 0; i < numToActivate; i++) {
    if (promptsToActivate[i]) {
      promptsToActivate[i].weight = 1;
    }
  }
  return new Map(defaultPrompts.map((p) => [p.promptId, p]));
}

function setStoredPrompts(prompts: Map<string, Prompt>) {
  const storedPrompts = JSON.stringify([...prompts.values()]);
  const {localStorage} = window;
  localStorage.setItem('prompts', storedPrompts);
}

function main(container: HTMLElement) {
  gen(container);
}

main(document.body);

declare global {
  interface HTMLElementTagNameMap {
    'prompt-dj': PromptDj;
    'prompt-controller': PromptController;
    'settings-controller': SettingsController;
    'add-prompt-button': AddPromptButton;
    'play-pause-button': PlayPauseButton;
    'reset-button': ResetButton;
    'weight-slider': WeightSlider;
    'toast-message': ToastMessage;
  }
}
