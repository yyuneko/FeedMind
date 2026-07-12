import { useState } from 'react';
import { ActivityIndicator, Pressable, SafeAreaView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useAuthStore } from '@/auth/authStore';
import { ApiError } from '@/api/client';
import { colors } from '@/utils/theme';

type Mode = 'login' | 'register' | 'verify' | 'forgot' | 'reset';

export function AuthScreen() {
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [token, setToken] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const auth = useAuthStore();
  const submit = async () => {
    setBusy(true); setError(''); setMessage('');
    try {
      if (mode === 'login') await auth.login(email, password);
      if (mode === 'register') { await auth.register(email, password); setMode('verify'); setMessage('验证邮件已发送，请输入邮件中的验证码。'); }
      if (mode === 'verify') { await auth.verifyEmail(token.trim()); await auth.login(email, password); }
      if (mode === 'forgot') { await auth.forgotPassword(email); setMode('reset'); setMessage('如果该邮箱已注册，重置验证码会发送到邮箱。'); }
      if (mode === 'reset') { await auth.resetPassword(token.trim(), password); setMode('login'); setToken(''); setMessage('密码已重置，请登录。'); }
    } catch (e) {
      const errorCode = e instanceof ApiError
        ? e.code
        : (typeof e === 'object' && e !== null && 'code' in e ? String(e.code) : '');
      const errorStatus = e instanceof ApiError
        ? e.status
        : (typeof e === 'object' && e !== null && 'status' in e ? Number(e.status) : 0);
      if (mode === 'login' && (errorCode === 'email_not_verified' || errorStatus === 403)) {
        setMode('verify');
        setMessage('邮箱尚未验证，正在重新发送验证码。');
        try {
          await auth.resendVerification(email);
          setMessage('邮箱尚未验证，新的验证码已发送。');
        } catch {
          setMessage('邮箱尚未验证，请输入已有验证码或点击重新发送。');
        }
      } else setError(e instanceof Error ? e.message : '请求失败');
    }
    finally { setBusy(false); }
  };
  const title = { login: '登录 FeedMind', register: '创建账号', verify: '验证邮箱', forgot: '找回密码', reset: '设置新密码' }[mode];
  return <SafeAreaView style={styles.safe}><View style={styles.card}>
    <Text style={styles.brand}>FeedMind</Text><Text style={styles.subtitle}>{title}</Text>
    {(mode !== 'verify' && mode !== 'reset') ? <TextInput style={styles.input} autoCapitalize="none" keyboardType="email-address" placeholder="邮箱" value={email} onChangeText={setEmail}/> : null}
    {(mode === 'verify' || mode === 'reset') ? <TextInput style={styles.input} autoCapitalize="none" placeholder="邮件验证码" value={token} onChangeText={setToken}/> : null}
    {(mode === 'login' || mode === 'register' || mode === 'reset') ? <TextInput style={styles.input} secureTextEntry placeholder={mode === 'reset' ? '新密码（至少 10 个字符）' : '密码（至少 10 个字符）'} value={password} onChangeText={setPassword}/> : null}
    {message ? <Text style={styles.message}>{message}</Text> : null}{error ? <Text style={styles.error}>{error}</Text> : null}
    <Pressable style={styles.button} onPress={submit} disabled={busy}>{busy ? <ActivityIndicator color="#fff"/> : <Text style={styles.buttonText}>{title}</Text>}</Pressable>
    {mode === 'verify' ? <Pressable onPress={async()=>{await auth.resendVerification(email);setMessage('验证邮件已重新发送。')}}><Text style={styles.link}>重新发送验证邮件</Text></Pressable> : null}
    {mode === 'login' ? <><Pressable onPress={()=>setMode('forgot')}><Text style={styles.link}>忘记密码？</Text></Pressable><Pressable onPress={()=>setMode('register')}><Text style={styles.link}>没有账号？注册</Text></Pressable></> : <Pressable onPress={()=>setMode('login')}><Text style={styles.link}>返回登录</Text></Pressable>}
  </View></SafeAreaView>;
}
const styles=StyleSheet.create({safe:{flex:1,backgroundColor:colors.background,justifyContent:'center',padding:24},card:{gap:14},brand:{fontSize:34,fontWeight:'900',color:colors.text},subtitle:{fontSize:18,color:colors.secondary,marginBottom:8},input:{height:48,borderWidth:1,borderColor:colors.border,borderRadius:10,paddingHorizontal:14,backgroundColor:colors.card},button:{height:48,borderRadius:10,backgroundColor:colors.blue,alignItems:'center',justifyContent:'center'},buttonText:{color:'#fff',fontWeight:'800'},link:{textAlign:'center',color:colors.blue,marginTop:4},message:{color:'#237a42'},error:{color:'#c0392b'}});
