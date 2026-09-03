import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { ActivityIndicator, Platform, Pressable, SafeAreaView, StyleSheet, Text, View } from 'react-native';
import { useAuthStore } from '@/auth/authStore';
import { radius, spacing, typography, useThemeColors } from '@/utils/theme';

export function AuthScreen() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const theme = useThemeColors();
  const login = async () => { setBusy(true); setError(''); try { await useAuthStore.getState().login(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '登录失败'); } finally { setBusy(false); } };
  return <SafeAreaView style={[styles.safe, { backgroundColor: theme.background }]}><View style={styles.panel}>
    <View style={[styles.logo, { backgroundColor: theme.blue }]}><Ionicons name="sparkles" size={24} color="#fff" /></View>
    <Text style={[styles.title, { color: theme.text }]}>欢迎使用 FeedMind</Text>
    <Text style={[styles.subtitle, { color: theme.secondary }]}>使用 Cloudflare Access 中获准的 Google 或 GitHub 身份登录。两个身份都会映射到同一个阅读账户。</Text>
    {error ? <Text style={styles.error}>{error}</Text> : null}
    <Pressable accessibilityRole="button" accessibilityState={{ disabled: busy, busy }} disabled={busy} onPress={login} style={({ pressed, hovered, focused }: any) => [styles.button, { backgroundColor: theme.blue }, hovered && { opacity: 0.92 }, pressed && styles.pressed, busy && styles.disabled, focused && { borderColor: theme.text, borderWidth: 2 }]}>
      {busy ? <ActivityIndicator color="#fff" /> : <><Ionicons name="shield-checkmark-outline" size={20} color="#fff" /><Text style={styles.buttonText}>使用 Google 或 GitHub 登录</Text></>}
    </Pressable>
    <Text style={[styles.note, { color: theme.subtle }]}>{Platform.OS === 'web' ? 'localhost 使用 Cloudflare Managed OAuth + PKCE 登录，凭证仅保存在当前标签页会话中。' : '登录将在系统浏览器中完成，并使用 PKCE 安全交换令牌。'}</Text>
  </View></SafeAreaView>;
}
const styles = StyleSheet.create({
  safe:{flex:1,alignItems:'center',justifyContent:'center',padding:spacing.xxxl},panel:{width:'100%',maxWidth:430,alignItems:'center'},
  logo:{width:52,height:52,borderRadius:radius.panel,alignItems:'center',justifyContent:'center',marginBottom:spacing.xxxl},
  title:{fontSize:28,lineHeight:34,fontWeight:'700',marginBottom:spacing.md},subtitle:{...typography.body,textAlign:'center',marginBottom:26},
  button:{width:'100%',minHeight:50,borderRadius:radius.control,flexDirection:'row',gap:10,alignItems:'center',justifyContent:'center'},
  buttonText:{color:'#fff',fontWeight:'600',fontSize:15},pressed:{opacity:.84,transform:[{scale:.99}]},disabled:{opacity:.55},error:{color:'#D70015',marginBottom:14,textAlign:'center'},note:{...typography.metadata,marginTop:spacing.xl,textAlign:'center'},
});
