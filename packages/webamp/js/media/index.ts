/* Emulate the native <audio> element with Web Audio API */
import { BANDS, MEDIA_STATUS } from "../constants";
import { Band } from "../types";
import Emitter from "../emitter";
import Disposable from "../Disposable";
import StereoBalanceNode from "./StereoBalanceNode";
import ElementSource from "./elementSource";

interface StereoBalanceNodeType extends AudioNode {
  constructor(context: AudioContext): StereoBalanceNodeType;
  balance: {
    value: number;
  };
}

export interface IMedia {
  /**
   * Set the volume from 0 to 100
   */
  setVolume(volume: number): void;
  /**
   * Set the stereo balance from -100 to 100
   */
  setBalance(balance: number): void;
  /**
   * Set the preamp value from 0 to 100
   * The input value represents -12db to 12db, where 50 is 0db (no change)
   * Equation used is: 10^((dB)/20) = x, where x is the gain value
   */
  setPreamp(value: number): void;
  /**
   * Register an event listener
   */
  on(event: string, callback: (...args: any[]) => void): void;
  /**
   * Get the current playback time in seconds
   */
  timeElapsed(): number;
  /**
   * Get the total duration of the current track in seconds
   */
  duration(): number;
  /**
   * Start or resume playback
   */
  play(): Promise<void>;
  /**
   * Pause playback
   */
  pause(): void;
  /**
   * Stop playback and reset position to beginning
   */
  stop(): void;
  /**
   * Seek to a specific position as a percentage of the total duration
   */
  seekToPercentComplete(percent: number): void;
  /**
   * Load a track from a URL and optionally start playing it
   * Used only for the initial load, since it must have a CORS header
   */
  loadFromUrl(url: string, autoPlay: boolean): Promise<void>;
  /**
   * Set the gain value for a specific EQ band
   */
  setEqBand(band: Band, value: number): void;
  /**
   * Disable the equalizer by bypassing all EQ bands
   */
  disableEq(): void;
  /**
   * Enable the equalizer processing
   */
  enableEq(): void;
  /**
   * Get the analyser node for visualizer data
   */
  getAnalyser(): AnalyserNode;
  /**
   * Clean up resources and dispose of the media instance
   */
  dispose(): void;
}

// A constructable class that implements the IMedia interface.
export interface IMediaClass {
  new (): IMedia;
}

// NOTE: While this is not technically a public API, https://winampify.io/ is
// replacing this class with a custom version. Breaking changes to this API
// surface should be communicated to Remi.
export default class Media implements IMedia {
  _emitter: Emitter;
  _context: AudioContext;
  _balance: StereoBalanceNodeType;
  _staticSource: GainNode;
  _preamp: GainNode;
  _analyser: AnalyserNode;
  _gainNode: GainNode;
  _source: ElementSource;
  _bands: { [band: number]: BiquadFilterNode };
  _disposable: Disposable;

  constructor() {
    this._emitter = new Emitter();
    this._disposable = new Disposable();
    // @ts-ignore Typescript does not know about webkitAudioContext
    this._context = new (window.AudioContext || window.webkitAudioContext)();
    // Fix for iOS and Chrome (Canary) which require that the context be created
    // or resumed by a user interaction.
    // https://developers.google.com/web/updates/2017/09/autoplay-policy-changes
    // https://gist.github.com/laziel/7aefabe99ee57b16081c
    // Via: https://stackoverflow.com/a/43395068/1263117
    if (this._context.state === "suspended") {
      const resumeHandler = async () => {
        await this._context.resume();

        if (this._context.state === "running") {
          document.body.removeEventListener("touchend", resumeHandler, false);
          document.body.removeEventListener("click", resumeHandler, false);
          document.body.removeEventListener("keydown", resumeHandler, false);
        }
      };

      document.body.addEventListener("touchend", resumeHandler, false);
      document.body.addEventListener("click", resumeHandler, false);
      document.body.addEventListener("keydown", resumeHandler, false);

      // Add cleanup for resume handlers
      this._disposable.add(() => {
        document.body.removeEventListener("touchend", resumeHandler, false);
        document.body.removeEventListener("click", resumeHandler, false);
        document.body.removeEventListener("keydown", resumeHandler, false);
      });
    }

    // TODO: Maybe we can get rid of this now that we are using AudioAbstraction?
    this._staticSource = this._context.createGain(); // Just a noop node

    // @ts-ignore The way this class has to be monkey patched, makes it very hard to type.
    this._balance = new StereoBalanceNode(this._context);

    // Create the preamp node
    this._preamp = this._context.createGain();

    // Create the analyser node for the visualizer
    this._analyser = this._context.createAnalyser();
    this._analyser.fftSize = 2048;
    // don't smooth audio analysis
    this._analyser.smoothingTimeConstant = 0.0;

    // Create the gain node for the volume control
    this._gainNode = this._context.createGain();

    // Connect all the nodes in the correct way
    // (Note, source is created and connected later)
    //
    //                <source>
    //                    |
    //                    |_____________
    //                    |             \
    //                <preamp>          |
    //                    |             | <-- Optional bypass
    //           [...biquadFilters]     |
    //                    |_____________/
    //                    |
    //              <staticSource>
    //                    |
    //                <balance>
    //                    |
    //                    |\
    //                    | <analyser>
    //                  <gain>
    //                    |
    //              <destination>

    this._source = new ElementSource(this._context, this._staticSource);

    this._source.on("positionChange", () => {
      this._emitter.trigger("timeupdate");
    });
    this._source.on("ended", () => {
      this._emitter.trigger("ended");
    });
    this._source.on("statusChange", () => {
      switch (this._source.getStatus()) {
        case MEDIA_STATUS.PLAYING:
          this._emitter.trigger("playing");
          break;
      }
      this._emitter.trigger("timeupdate");
    });
    this._source.on("loaded", () => {
      this._emitter.trigger("fileLoaded");
    });

    this._staticSource.connect(this._preamp);

    let output = this._preamp;
    this._bands = {};

    BANDS.forEach((band, i) => {
      const filter = this._context.createBiquadFilter();

      this._bands[band] = filter;

      if (i === 0) {
        // The first filter, includes all lower frequencies
        filter.type = "lowshelf";
      } else if (i === BANDS.length - 1) {
        // The last filter, includes all higher frequencies
        filter.type = "highshelf";
      } else {
        filter.type = "peaking";
      }
      filter.frequency.value = band;
      filter.gain.value = 0;

      output.connect(filter);
      output = filter;
    });

    output.connect(this._balance);

    this._balance.connect(this._gainNode);
    this._balance.connect(this._analyser);

    this._gainNode.connect(this._context.destination);
  }

  getAnalyser() {
    return this._analyser;
  }

  /* Properties */
  duration() {
    return this._source.getDuration();
  }

  timeElapsed() {
    return this._source.getTimeElapsed();
  }

  timeRemaining() {
    return this.duration() - this.timeElapsed();
  }

  percentComplete() {
    return (this.timeElapsed() / this.duration()) * 100;
  }

  /* Actions */
  async play() {
    await this._source.play();
  }

  pause() {
    this._source.pause();
  }

  stop() {
    this._source.stop();
  }

  /* Actions with arguments */
  seekToPercentComplete(percent: number) {
    const seekTime = this.duration() * (percent / 100);
    this.seekToTime(seekTime);
  }

  // From 0-1
  setVolume(volume: number) {
    this._gainNode.gain.value = volume / 100;
  }

  // from 0 to 100
  // The input value here is 0-100 which is kinda wrong, since it represents -12db to 12db.
  // For now, 50 is 0db (no change).
  // Equation used is: 10^((dB)/20) = x, where x (preamp.gain.value) is passed on to gainnode for boosting or attenuation.
  setPreamp(value: number) {
    const db = (value / 100) * 24 - 12;
    this._preamp.gain.value = Math.pow(10, db / 20);
  }

  // From -100 to 100
  setBalance(balance: number) {
    // Yo Dawg.
    this._balance.balance.value = balance / 100;
  }

  setEqBand(band: Band, value: number) {
    const db = (value / 100) * 24 - 12;
    this._bands[band].gain.value = db;
  }

  disableEq() {
    this._staticSource.disconnect();
    this._staticSource.connect(this._balance);
  }

  enableEq() {
    this._staticSource.disconnect();
    this._staticSource.connect(this._preamp);
  }

  /* Listeners */
  on(event: string, callback: (...args: any[]) => void) {
    this._emitter.on(event, callback);
  }

  seekToTime(time: number) {
    this._source.seekToTime(time);
  }

  // Used only for the initial load, since it must have a CORS header
  async loadFromUrl(url: string, autoPlay: boolean) {
    this._emitter.trigger("waiting");
    await this._source.loadUrl(url);
    // TODO #race
    this._emitter.trigger("stopWaiting");
    if (autoPlay) {
      this.play();
    }
  }

  dispose() {
    // Clean up all event listeners via disposable
    this._disposable.dispose();

    this._source.dispose();
    this._emitter.dispose();
  }
}
