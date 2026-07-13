import { createElement } from 'react';
import { StyleSheet, View } from 'react-native';
import { withAutomaticPlayback } from '@/utils/articleMedia';

type ArticleMediaProps = {
  kind: 'video' | 'embed';
  uri: string;
  poster?: string;
  width: number;
};

const mediaHeight = (width: number) => Math.max(180, Math.round(width * 9 / 16));

export function ArticleMedia({ kind, uri, poster, width }: ArticleMediaProps) {
  if (!uri) return null;
  const height = mediaHeight(width);
  const media = kind === 'video'
    ? createElement('video', {
      src: uri,
      poster,
      controls: true,
      autoPlay: true,
      loop: true,
      muted: true,
      playsInline: true,
      preload: 'auto',
      style: styles.media,
    })
    : createElement('iframe', {
      src: withAutomaticPlayback(uri),
      title: 'Embedded article video',
      allow: 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share',
      allowFullScreen: true,
      referrerPolicy: 'strict-origin-when-cross-origin',
      style: styles.media,
    });
  return <View style={[styles.container, { width, height }]}>{media}</View>;
}

const styles = StyleSheet.create({
  container: {
    alignSelf: 'center',
    marginVertical: 10,
    overflow: 'hidden',
    borderRadius: 8,
    backgroundColor: '#000',
  },
  media: {
    width: '100%',
    height: '100%',
    borderWidth: 0,
    backgroundColor: '#000',
  },
});
