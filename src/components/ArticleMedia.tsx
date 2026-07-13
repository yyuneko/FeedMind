import { Ionicons } from '@expo/vector-icons';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { withAutomaticPlayback } from '@/utils/articleMedia';

type ArticleMediaProps = {
  kind: 'video' | 'embed';
  uri: string;
  poster?: string;
  width: number;
};

const mediaHeight = (width: number) => Math.max(180, Math.round(width * 9 / 16));

const ArticleVideo = ({ uri, width }: Omit<ArticleMediaProps, 'kind'>) => {
  const [muted, setMuted] = useState(true);
  const player = useVideoPlayer(uri, (videoPlayer) => {
    videoPlayer.loop = true;
    videoPlayer.muted = true;
    videoPlayer.play();
  });
  const toggleMuted = () => {
    const next = !muted;
    player.muted = next;
    setMuted(next);
  };
  return (
    <View style={{ width, height: mediaHeight(width) }}>
      <VideoView
        player={player}
        nativeControls
        allowsFullscreen
        contentFit="contain"
        style={styles.video}
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={muted ? '取消静音' : '静音'}
        hitSlop={8}
        onPress={toggleMuted}
        style={({ pressed }) => [styles.muteButton, pressed && styles.pressed]}
      >
        <Ionicons name={muted ? 'volume-mute' : 'volume-high'} size={20} color="#fff" />
      </Pressable>
    </View>
  );
};

export function ArticleMedia({ kind, uri, width }: ArticleMediaProps) {
  if (!uri) return null;
  const automaticUri = kind === 'embed' ? withAutomaticPlayback(uri) : uri;
  return (
    <View style={[styles.container, { width, height: mediaHeight(width) }]}>
      {kind === 'video' ? (
        <ArticleVideo uri={uri} width={width} />
      ) : (
        <WebView
          source={{ uri: automaticUri }}
          style={styles.webView}
          originWhitelist={['https://*', 'http://*']}
          javaScriptEnabled
          domStorageEnabled
          mediaPlaybackRequiresUserAction={false}
          allowsFullscreenVideo
          allowsInlineMediaPlayback
          scrollEnabled={false}
          setSupportMultipleWindows={false}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignSelf: 'center',
    marginVertical: 10,
    overflow: 'hidden',
    borderRadius: 8,
    backgroundColor: '#000',
  },
  webView: {
    flex: 1,
    backgroundColor: '#000',
  },
  video: {
    ...StyleSheet.absoluteFillObject,
  },
  muteButton: {
    position: 'absolute',
    top: 10,
    right: 10,
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.62)',
  },
  pressed: {
    opacity: 0.65,
  },
});
