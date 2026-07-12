import * as Clipboard from 'expo-clipboard';
import { Ionicons } from '@expo/vector-icons';
import React, { Component, type ErrorInfo, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Platform, Pressable, ScrollView, StyleSheet, Text, type TextStyle, View } from 'react-native';
import { Highlight, themes } from 'prism-react-renderer';
import { t } from '@/i18n';
import { articlePrism } from '@/utils/prism';

const codeFontFamily = Platform.select({
  web: 'ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, Liberation Mono, monospace',
  ios: 'Menlo',
  default: 'monospace',
});

type Props = { code: string; language?: string; languageLabel?: string; dark: boolean; width: number; borderColor: string; backgroundColor: string; textColor: string; fontSize: number };

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

export const ArticleCodeBlock = ({ code, language, languageLabel, dark, width, borderColor, backgroundColor, textColor, fontSize }: Props) => {
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const label = languageLabel || language || t('plainText');
  const contentWidth = Math.max(0, width - StyleSheet.hairlineWidth * 2);
  const accentColor = dark ? '#8AB4F8' : '#2563EB';
  const headerBackground = dark ? '#20242A' : '#F1F5F9';
  const highlighterStyle = useMemo(() => {
    const theme = dark ? themes.oneDark : themes.oneLight;
    return {
      ...theme,
      plain: { ...theme.plain, color: textColor, backgroundColor },
    };
  }, [backgroundColor, dark, textColor]);
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
        {language ? (
          <Highlight prism={articlePrism} theme={highlighterStyle} language={language} code={code}>
            {({ tokens, getTokenProps }) => (
              <ScrollView horizontal showsHorizontalScrollIndicator style={{ backgroundColor }} contentContainerStyle={[styles.codeContent, { minWidth: contentWidth }]}>
                <View>
                  {tokens.map((line, lineIndex) => (
                    <Text selectable key={lineIndex} style={[styles.codeText, styles.preserveWhitespace, { color: textColor, fontSize }]}>
                      {line.map((token, tokenIndex) => {
                        const tokenProps = getTokenProps({ token });
                        return <Text key={tokenIndex} style={tokenProps.style as TextStyle}>{tokenProps.children}</Text>;
                      })}
                      {line.length === 1 && line[0].empty ? ' ' : null}
                    </Text>
                  ))}
                </View>
              </ScrollView>
            )}
          </Highlight>
        ) : fallback}
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
