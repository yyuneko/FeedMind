import React from 'react';
import { StyleSheet, View } from 'react-native';
import { SvgXml } from 'react-native-svg';

const numeric = (value?: string) => {
  const parsed = Number.parseFloat(value ?? '');
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
};

export function ArticleSvg({ xml, width, containerBackgroundColor, surfaceBackgroundColor }: {
  xml: string;
  width: number;
  containerBackgroundColor: string;
  surfaceBackgroundColor: string;
}) {
  const viewBox = xml.match(/\bviewBox=["']\s*[-\d.]+\s+[-\d.]+\s+([\d.]+)\s+([\d.]+)\s*["']/i);
  const sourceWidth = numeric(viewBox?.[1]) ?? numeric(xml.match(/\bwidth=["']([^"']+)/i)?.[1]);
  const sourceHeight = numeric(viewBox?.[2]) ?? numeric(xml.match(/\bheight=["']([^"']+)/i)?.[1]);
  const height = Math.max(40, Math.min(width * 2, sourceWidth && sourceHeight ? width * sourceHeight / sourceWidth : width * 0.6));
  if (!xml) return null;
  const normalizedXml = xml
    .replace(/\bviewbox=/gi, 'viewBox=')
    .replace(/\bpreserveaspectratio=/gi, 'preserveAspectRatio=')
    .replace(/<lineargradient\b/gi, '<linearGradient').replace(/<\/lineargradient>/gi, '</linearGradient>')
    .replace(/<radialgradient\b/gi, '<radialGradient').replace(/<\/radialgradient>/gi, '</radialGradient>')
    .replace(/<clippath\b/gi, '<clipPath').replace(/<\/clippath>/gi, '</clipPath>');
  return (
    <View style={[styles.container, { width, backgroundColor: containerBackgroundColor }]}>
      <View style={[styles.surface, { width, height, backgroundColor: surfaceBackgroundColor }]}>
        <SvgXml xml={normalizedXml} width={width} height={height} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginVertical: 8,
    alignItems: 'center',
  },
  surface: {
    overflow: 'hidden',
    borderRadius: 6,
  },
});
