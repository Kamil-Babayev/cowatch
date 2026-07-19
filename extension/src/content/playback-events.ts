/**
 * Attaches play/pause/seeked listeners to a video element and reports a
 * normalized event shape. Deliberately has no networking, no messaging to
 * the background script — that's US-2.6. Keeping this pure DOM-in,
 * callback-out means event-capture bugs and networking bugs are never
 * debugged at the same time, per this story's own reasoning in the
 * implementation sequence.
 */

export interface PlaybackEvent {
  type: 'play' | 'pause' | 'seeked';
  currentTime: number;
  isPlaying: boolean;
}

export type PlaybackEventHandler = (event: PlaybackEvent) => void;

export function attachPlaybackListeners(
  video: HTMLVideoElement,
  onEvent: PlaybackEventHandler,
): () => void {
  const handlePlay = () => {
    onEvent({ type: 'play', currentTime: video.currentTime, isPlaying: true });
  };
  const handlePause = () => {
    onEvent({ type: 'pause', currentTime: video.currentTime, isPlaying: false });
  };
  const handleSeeked = () => {
    // isPlaying reflects whatever state the video was actually in when the
    // seek landed — a seek can happen while paused just as easily as while
    // playing, and US-1.8's cache needs to know which.
    onEvent({ type: 'seeked', currentTime: video.currentTime, isPlaying: !video.paused });
  };

  video.addEventListener('play', handlePlay);
  video.addEventListener('pause', handlePause);
  video.addEventListener('seeked', handleSeeked);

  return function detach(): void {
    video.removeEventListener('play', handlePlay);
    video.removeEventListener('pause', handlePause);
    video.removeEventListener('seeked', handleSeeked);
  };
}
