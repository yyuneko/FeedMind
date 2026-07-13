export const withAutomaticPlayback = (value: string) => {
  try {
    const url = new URL(value);
    url.searchParams.set('autoplay', '1');
    url.searchParams.set('loop', '1');
    url.searchParams.set('mute', '1');
    url.searchParams.set('muted', '1');

    if (/^(?:www\.)?youtube(?:-nocookie)?\.com$/i.test(url.hostname)) {
      const videoId = url.pathname.match(/^\/embed\/([^/?]+)/i)?.[1];
      if (videoId) url.searchParams.set('playlist', videoId);
    }
    return url.href;
  } catch {
    return value;
  }
};
