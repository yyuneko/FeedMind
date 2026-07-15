import React, { useMemo, useState } from 'react';
import { Linking, StyleSheet, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { renderFormulaMarkup } from '@/utils/formula';

type ArticleRichContentProps = {
  html: string;
  width: number;
  color: string;
  backgroundColor: string;
  fontSize: number;
  lineHeight: number;
  fontFamily?: string;
};

const escapeCss = (value: string) => value.replace(/[\\"\r\n]/g, '');

export function ArticleRichContent({ html, width, color, backgroundColor, fontSize, lineHeight, fontFamily }: ArticleRichContentProps) {
  const [height, setHeight] = useState(Math.max(lineHeight + 12, 44));
  const source = useMemo(() => {
    const content = renderFormulaMarkup(html);
    const family = fontFamily ? `font-family:"${escapeCss(fontFamily)}";` : '';
    return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"><style>
      html,body{margin:0;padding:0;background:${escapeCss(backgroundColor)};color:${escapeCss(color)};${family}font-size:${fontSize}px;line-height:${lineHeight}px;overflow:hidden}
      p{margin:0 0 10px}a{color:#2563eb}math{max-width:100%;overflow-x:auto}.feedmind-formula-block{text-align:center;overflow-x:auto;margin:8px 0}.feedmind-formula-inline{display:inline}.feedmind-formula-error{white-space:pre-wrap}
    </style></head><body>${content}<script>const send=()=>window.ReactNativeWebView.postMessage(String(Math.ceil(document.documentElement.scrollHeight)));new ResizeObserver(send).observe(document.body);send();</script></body></html>`;
  }, [backgroundColor, color, fontFamily, fontSize, html, lineHeight]);
  return (
    <View style={[styles.container, { width, height, backgroundColor }]}>
      <WebView
        source={{ html: source, baseUrl: 'about:blank' }}
        style={{ backgroundColor }}
        originWhitelist={['about:*', 'https://*']}
        javaScriptEnabled
        scrollEnabled={false}
        setSupportMultipleWindows={false}
        onMessage={(event) => {
          const next = Math.ceil(Number(event.nativeEvent.data));
          if (Number.isFinite(next) && next > 0) setHeight(Math.min(4000, next));
        }}
        onShouldStartLoadWithRequest={(request) => {
          if (request.url === 'about:blank') return true;
          if (/^https:\/\//i.test(request.url)) Linking.openURL(request.url).catch(() => undefined);
          return false;
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { alignSelf: 'stretch', overflow: 'hidden' },
});
