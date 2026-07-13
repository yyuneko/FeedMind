import * as Clipboard from 'expo-clipboard';
import { Ionicons } from '@expo/vector-icons';
import React, { Component, type ErrorInfo, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Platform, Pressable, ScrollView, StyleSheet, Text, type TextStyle, View } from 'react-native';
import { t } from '@/i18n';
import { highlightCode } from '@/utils/highlight';

const codeFontFamily = Platform.select({
  web: 'ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, Liberation Mono, monospace',
  ios: 'Menlo',
  default: 'monospace',
});

type Props = { code: string; language?: string; dark: boolean; width: number; borderColor: string; backgroundColor: string; textColor: string; fontSize: number };

const lightScopeColors: Record<string, string> = {
  'hljs-attr': '#005CC5', 'hljs-attribute': '#6F42C1', 'hljs-built_in': '#005CC5', 'hljs-bullet': '#735C0F',
  'hljs-comment': '#6A737D', 'hljs-doctag': '#22863A', 'hljs-keyword': '#D73A49', 'hljs-literal': '#005CC5',
  'hljs-meta': '#735C0F', 'hljs-name': '#22863A', 'hljs-number': '#005CC5', 'hljs-params': '#24292E',
  'hljs-regexp': '#032F62', 'hljs-section': '#005CC5', 'hljs-selector-class': '#6F42C1', 'hljs-selector-id': '#6F42C1',
  'hljs-string': '#032F62', 'hljs-symbol': '#005CC5', 'hljs-tag': '#22863A', 'hljs-title': '#6F42C1',
  'hljs-type': '#D73A49', 'hljs-variable': '#E36209',
};
const darkScopeColors: Record<string, string> = {
  'hljs-attr': '#79C0FF', 'hljs-attribute': '#D2A8FF', 'hljs-built_in': '#79C0FF', 'hljs-bullet': '#E3B341',
  'hljs-comment': '#8B949E', 'hljs-doctag': '#7EE787', 'hljs-keyword': '#FF7B72', 'hljs-literal': '#79C0FF',
  'hljs-meta': '#E3B341', 'hljs-name': '#7EE787', 'hljs-number': '#79C0FF', 'hljs-params': '#C9D1D9',
  'hljs-regexp': '#A5D6FF', 'hljs-section': '#79C0FF', 'hljs-selector-class': '#D2A8FF', 'hljs-selector-id': '#D2A8FF',
  'hljs-string': '#A5D6FF', 'hljs-symbol': '#79C0FF', 'hljs-tag': '#7EE787', 'hljs-title': '#D2A8FF',
  'hljs-type': '#FF7B72', 'hljs-variable': '#FFA657',
};

class HighlightBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error, info: ErrorInfo) {
    if (__DEV__) console.warn('Code highlighting failed; using plain text.', error, info.componentStack);
  }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

const PlainCode = ({ code, color, backgroundColor, width, fontSize }: { code: string; color: string; backgroundColor: string; width: number; fontSize: number }) => (
  <ScrollView horizontal showsHorizontalScrollIndicator style={{ backgroundColor }} contentContainerStyle={[styles.codeContent, { minWidth: width }]}>
    <Text selectable style={[styles.codeText, styles.preserveWhitespace, { color, fontSize }]}>{code}</Text>
  </ScrollView>
);

export const ArticleCodeBlock = ({ code, language, dark, width, borderColor, backgroundColor, textColor, fontSize }: Props) => {
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const highlighted = useMemo(() => highlightCode(code, language), [code, language]);
  const label = highlighted.language || t('plainText');
  const contentWidth = Math.max(0, width - StyleSheet.hairlineWidth * 2);
  const accentColor = dark ? '#8AB4F8' : '#2563EB';
  const headerBackground = dark ? '#20242A' : '#F1F5F9';
  const scopeColors = dark ? darkScopeColors : lightScopeColors;
  const fallback = <PlainCode code={code} color={textColor} backgroundColor={backgroundColor} width={contentWidth} fontSize={fontSize} />;
  useEffect(() => () => {
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
  }, []);
  const copy = async () => {
    try {
      await Clipboard.setStringAsync(code);
      setCopied(true);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), 1800);
    } catch {
      Alert.alert(t('copyFailed'));
    }
  };
  return (
    <View style={[styles.container, { borderColor, backgroundColor, maxWidth: width }]}>
      <View style={[styles.header, { borderBottomColor: borderColor, backgroundColor: headerBackground }]}>
        <Text style={[styles.language, { color: textColor }]} numberOfLines={1}>{label}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel={t('copyCode')} hitSlop={8} onPress={copy} style={({ pressed }) => [styles.copyButton, pressed && styles.pressed]}>
          <Ionicons name={copied ? 'checkmark-outline' : 'copy-outline'} size={15} color={accentColor} />
          <Text accessibilityLiveRegion="polite" style={[styles.copyText, { color: accentColor }]}>{copied ? t('copiedCode') : t('copyCode')}</Text>
        </Pressable>
      </View>
      <HighlightBoundary fallback={fallback}>
        <ScrollView horizontal showsHorizontalScrollIndicator style={{ backgroundColor }} contentContainerStyle={[styles.codeContent, { minWidth: contentWidth }]}>
          <View>
            {highlighted.tokens.map((line, lineIndex) => (
              <Text selectable key={lineIndex} style={[styles.codeText, styles.preserveWhitespace, { color: textColor, fontSize }]}>
                {line.map((token, tokenIndex) => {
                  const color = [...token.scopes].reverse().map((scope) => scopeColors[scope]).find(Boolean);
                  return <Text key={tokenIndex} style={color ? { color } : undefined}>{token.text}</Text>;
                })}
                {line.length === 0 ? ' ' : null}
              </Text>
            ))}
          </View>
        </ScrollView>
      </HighlightBoundary>
    </View>
  );
};

const styles = StyleSheet.create({
  container: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, marginVertical: 10, overflow: 'hidden' },
  header: { minHeight: 36, paddingHorizontal: 12, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  language: { fontSize: 12, fontWeight: '700', textTransform: 'uppercase', flexShrink: 1 },
  copyButton: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingVertical: 7, paddingLeft: 12 },
  copyText: { fontSize: 12, fontWeight: '600' },
  codeContent: { padding: 12 },
  codeText: { fontFamily: codeFontFamily, lineHeight: 20 },
  preserveWhitespace: Platform.OS === 'web' ? ({ whiteSpace: 'pre' } as TextStyle) : {},
  pressed: { opacity: 0.55 },
});
