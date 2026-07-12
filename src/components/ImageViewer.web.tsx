import { Image } from 'expo-image';
import type { ComponentType } from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';

type ImageSource = { uri: string } | number;

type ImageViewerProps = {
  images: ImageSource[];
  imageIndex: number;
  visible: boolean;
  onRequestClose: () => void;
  backgroundColor?: string;
  HeaderComponent?: ComponentType<{ imageIndex: number }>;
  doubleTapToZoomEnabled?: boolean;
  swipeToCloseEnabled?: boolean;
};

export default function ImageViewer({
  images,
  imageIndex,
  visible,
  onRequestClose,
  backgroundColor = '#000',
  HeaderComponent,
}: ImageViewerProps) {
  const source = images[imageIndex];

  return (
    <Modal transparent visible={visible} animationType='fade' onRequestClose={onRequestClose}>
      <View style={[styles.container, { backgroundColor }]}>
        <Pressable
          accessibilityRole='button'
          accessibilityLabel='Close image preview'
          style={StyleSheet.absoluteFill}
          onPress={onRequestClose}
        />
        {source && <Image source={source} style={styles.image} contentFit='contain' />}
        {HeaderComponent && <HeaderComponent imageIndex={imageIndex} />}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  image: {
    width: '100%',
    height: '100%',
    pointerEvents: 'none',
  },
});
