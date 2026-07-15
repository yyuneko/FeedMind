import React, { useMemo } from 'react';
import { View } from 'react-native';
import { SvgXml } from 'react-native-svg';

const numeric = (value?: string) => {
  const parsed = Number.parseFloat(value ?? '');
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
};

export function ArticleSvg({ xml, width }: { xml: string; width: number }) {
  const height = useMemo(() => {
    const viewBox = xml.match(/\bviewBox=["']\s*[-\d.]+\s+[-\d.]+\s+([\d.]+)\s+([\d.]+)\s*["']/i);
    const sourceWidth = numeric(viewBox?.[1]) ?? numeric(xml.match(/\bwidth=["']([^"']+)/i)?.[1]);
    const sourceHeight = numeric(viewBox?.[2]) ?? numeric(xml.match(/\bheight=["']([^"']+)/i)?.[1]);
    return Math.max(40, Math.min(width * 2, sourceWidth && sourceHeight ? width * sourceHeight / sourceWidth : width * 0.6));
  }, [width, xml]);
  if (!xml) return null;
  const normalizedXml = xml
    .replace(/\bviewbox=/gi, 'viewBox=')
    .replace(/\bpreserveaspectratio=/gi, 'preserveAspectRatio=')
    .replace(/<lineargradient\b/gi, '<linearGradient').replace(/<\/lineargradient>/gi, '</linearGradient>')
    .replace(/<radialgradient\b/gi, '<radialGradient').replace(/<\/radialgradient>/gi, '</radialGradient>')
    .replace(/<clippath\b/gi, '<clipPath').replace(/<\/clippath>/gi, '</clipPath>');
  return <View style={{ width, height, marginVertical: 8 }}><SvgXml xml={normalizedXml} width={width} height={height} /></View>;
}
