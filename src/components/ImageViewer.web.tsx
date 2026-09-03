import { Image } from 'expo-image';
import type { ComponentType } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Modal, PanResponder, Pressable, StyleSheet, View } from 'react-native';

type ImageSource = { uri: string } | number;
type Position = { x: number; y: number };

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

const minimumScale = 1;
const maximumScale = 6;

export default function ImageViewer({
  images,
  imageIndex,
  visible,
  onRequestClose,
  backgroundColor = '#000',
  HeaderComponent,
  doubleTapToZoomEnabled = true,
}: ImageViewerProps) {
  const source = images[imageIndex];
  const sourceKey = typeof source === 'number' ? source : source?.uri;
  const stageRef = useRef<View>(null);
  const viewportRef = useRef({ width: 0, height: 0 });
  const scaleRef = useRef(minimumScale);
  const positionRef = useRef<Position>({ x: 0, y: 0 });
  const dragStartRef = useRef<Position>({ x: 0, y: 0 });
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [scale, setScale] = useState(minimumScale);
  const [position, setPosition] = useState<Position>({ x: 0, y: 0 });

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current === null) return;
    clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  }, []);

  const clampPosition = useCallback((next: Position, nextScale = scaleRef.current): Position => {
    const { width, height } = viewportRef.current;
    const maxX = Math.max(0, width * (nextScale - 1) / 2);
    const maxY = Math.max(0, height * (nextScale - 1) / 2);
    return {
      x: Math.min(maxX, Math.max(-maxX, next.x)),
      y: Math.min(maxY, Math.max(-maxY, next.y)),
    };
  }, []);

  const updateTransform = useCallback((nextScale: number, nextPosition: Position) => {
    const boundedScale = Math.min(maximumScale, Math.max(minimumScale, nextScale));
    const boundedPosition = boundedScale === minimumScale
      ? { x: 0, y: 0 }
      : clampPosition(nextPosition, boundedScale);
    scaleRef.current = boundedScale;
    positionRef.current = boundedPosition;
    setScale(boundedScale);
    setPosition(boundedPosition);
  }, [clampPosition]);

  const resetTransform = useCallback(() => {
    updateTransform(minimumScale, { x: 0, y: 0 });
  }, [updateTransform]);

  useEffect(() => {
    clearCloseTimer();
    resetTransform();
  }, [clearCloseTimer, imageIndex, resetTransform, sourceKey, visible]);

  useEffect(() => () => clearCloseTimer(), [clearCloseTimer]);

  useEffect(() => {
    if (!visible) return undefined;
    const element = stageRef.current as unknown as HTMLElement | null;
    if (!element) return undefined;
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      const currentScale = scaleRef.current;
      const factor = Math.exp(-event.deltaY * 0.0015);
      const nextScale = Math.min(maximumScale, Math.max(minimumScale, currentScale * factor));
      if (nextScale === currentScale) return;
      const bounds = element.getBoundingClientRect();
      const cursorX = event.clientX - bounds.left - bounds.width / 2;
      const cursorY = event.clientY - bounds.top - bounds.height / 2;
      const ratio = nextScale / currentScale;
      updateTransform(nextScale, {
        x: cursorX - (cursorX - positionRef.current.x) * ratio,
        y: cursorY - (cursorY - positionRef.current.y) * ratio,
      });
    };
    element.addEventListener('wheel', handleWheel, { passive: false });
    return () => element.removeEventListener('wheel', handleWheel);
  }, [updateTransform, visible]);

  const panResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => scaleRef.current > minimumScale,
    onMoveShouldSetPanResponder: (_event, gesture) => scaleRef.current > minimumScale && (Math.abs(gesture.dx) > 2 || Math.abs(gesture.dy) > 2),
    onPanResponderGrant: () => {
      dragStartRef.current = positionRef.current;
    },
    onPanResponderMove: (_event, gesture) => {
      updateTransform(scaleRef.current, {
        x: dragStartRef.current.x + gesture.dx,
        y: dragStartRef.current.y + gesture.dy,
      });
    },
  }), [updateTransform]);

  const handleBackdropPress = useCallback(() => {
    if (scaleRef.current > minimumScale) return;
    if (!doubleTapToZoomEnabled) {
      onRequestClose();
      return;
    }
    clearCloseTimer();
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null;
      onRequestClose();
    }, 220);
  }, [clearCloseTimer, doubleTapToZoomEnabled, onRequestClose]);

  const handleDoubleClick = useCallback(() => {
    if (!doubleTapToZoomEnabled) return;
    clearCloseTimer();
    if (scaleRef.current > minimumScale) resetTransform();
    else updateTransform(2.5, { x: 0, y: 0 });
  }, [clearCloseTimer, doubleTapToZoomEnabled, resetTransform, updateTransform]);

  return (
    <Modal transparent visible={visible} animationType='fade' onRequestClose={onRequestClose}>
      <View style={[styles.container, { backgroundColor }]}>
        <View
          ref={stageRef}
          {...panResponder.panHandlers}
          {...({ onDoubleClick: handleDoubleClick } as object)}
          style={styles.stage}
          onLayout={(event) => {
            viewportRef.current = event.nativeEvent.layout;
            updateTransform(scaleRef.current, positionRef.current);
          }}
        >
          <Pressable
            accessibilityRole='button'
            accessibilityLabel='Close image preview'
            style={StyleSheet.absoluteFill}
            onPress={handleBackdropPress}
          />
          {source && (
            <Image
              source={source}
              style={[styles.image, { transform: [{ translateX: position.x }, { translateY: position.y }, { scale }] }]}
              contentFit='contain'
            />
          )}
        </View>
        {HeaderComponent && <HeaderComponent imageIndex={imageIndex} />}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    overflow: 'hidden',
  },
  stage: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  image: {
    width: '100%',
    height: '100%',
    pointerEvents: 'none',
  },
});
