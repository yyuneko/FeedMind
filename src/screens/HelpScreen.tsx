import { Alert, Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { IconButton } from '@/components/IconButton';
import { helpMarkdown } from '@/docs/helpMarkdown';
import { getLocale, t } from '@/i18n';
import { useAppStore } from '@/store/appStore';
import { colors, useThemeColors } from '@/utils/theme';
import { screenStyles } from './screenStyles';

export function HelpScreen() {
  const themeColors = useThemeColors();
  useAppStore((state) => state.languageMode);

  return (
    <SafeAreaView style={[screenStyles.safe, { backgroundColor: themeColors.background }]}>
      <View style={screenStyles.header}>
        <IconButton name="chevron-back" onPress={() => router.back()} />
        <Text style={[screenStyles.navTitle, { color: themeColors.text }]}>{t('help')}</Text>
        <View style={styles.headerSpacer} />
      </View>
      <ScrollView contentContainerStyle={[screenStyles.content, styles.content]}>
        <MarkdownText markdown={helpMarkdown[getLocale()]} />
      </ScrollView>
    </SafeAreaView>
  );
}

const MarkdownText = ({ markdown }: {
  markdown: string;
}) => {
  const themeColors = useThemeColors();
  const blocks = toMarkdownBlocks(markdown);

  return (
    <>
      {blocks.map((block, index) => {
        if (block.type === 'h1') return <Text key={index} style={[styles.h1, { color: themeColors.text }]}>{block.text}</Text>;
        if (block.type === 'h2') return <Text key={index} style={[styles.h2, { color: themeColors.text }]}>{block.text}</Text>;
        if (block.type === 'h3') return <Text key={index} style={[styles.h3, { color: themeColors.text }]}>{block.text}</Text>;
        if (block.type === 'code') {
          return (
            <View key={index} style={[styles.codeBlock, { backgroundColor: themeColors.page, borderColor: themeColors.border }]}>
              <Text style={[styles.code, { color: themeColors.text }]}>{block.text}</Text>
            </View>
          );
        }
        const link = parseLink(block.text);
        if (link) {
          return (
            <Pressable key={index} style={[styles.linkRow, { borderBottomColor: themeColors.border }]} onPress={() => Linking.openURL(link.url).catch(() => Alert.alert(t('linkOpenFailed')))}>
              <Text style={[screenStyles.link, { color: themeColors.blue }]}>{link.label}</Text>
            </Pressable>
          );
        }
        return <Text key={index} style={[styles.paragraph, { color: themeColors.secondary }]}>{block.text}</Text>;
      })}
    </>
  );
};

type MarkdownBlock = {
  type: 'h1' | 'h2' | 'h3' | 'p' | 'code';
  text: string;
};

const toMarkdownBlocks = (markdown: string) => {
  const blocks: MarkdownBlock[] = [];
  const lines = markdown.trim().split('\n');
  let codeLines: string[] = [];
  let inCode = false;

  for (const line of lines) {
    if (line.startsWith('```')) {
      if (inCode) {
        blocks.push({ type: 'code', text: codeLines.join('\n') });
        codeLines = [];
      }
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      codeLines.push(line);
      continue;
    }
    const text = line.trim();
    if (!text) continue;
    if (text.startsWith('### ')) blocks.push({ type: 'h3', text: text.slice(4) });
    else if (text.startsWith('## ')) blocks.push({ type: 'h2', text: text.slice(3) });
    else if (text.startsWith('# ')) blocks.push({ type: 'h1', text: text.slice(2) });
    else blocks.push({ type: 'p', text });
  }
  if (codeLines.length) blocks.push({ type: 'code', text: codeLines.join('\n') });
  return blocks;
};

const parseLink = (text: string) => {
  const match = text.match(/^\[([^\]]+)\]\((https?:\/\/[^)]+)\)$/);
  return match ? { label: match[1], url: match[2] } : null;
};

const styles = StyleSheet.create({
  content: {
    paddingBottom: 28,
  },
  headerSpacer: {
    width: 44,
  },
  h1: {
    marginTop: 6,
    marginBottom: 14,
    color: colors.text,
    fontSize: 24,
    lineHeight: 31,
    fontWeight: '800',
  },
  h2: {
    marginTop: 22,
    marginBottom: 10,
    color: colors.text,
    fontSize: 17,
    lineHeight: 23,
    fontWeight: '800',
  },
  h3: {
    marginTop: 18,
    marginBottom: 8,
    color: colors.text,
    fontSize: 15,
    lineHeight: 21,
    fontWeight: '800',
  },
  paragraph: {
    marginBottom: 10,
    color: colors.secondary,
    fontSize: 14,
    lineHeight: 21,
  },
  linkRow: {
    height: 42,
    justifyContent: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  codeBlock: {
    marginBottom: 12,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: colors.page,
  },
  code: {
    color: colors.text,
    fontFamily: 'Courier',
    fontSize: 12,
    lineHeight: 18,
  },
});
