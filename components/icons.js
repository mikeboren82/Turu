import Svg, { Circle, Rect, Path, Line, Polyline, G } from 'react-native-svg';
import { colors } from '../constants/theme';

export function LocationPinIcon({ size = 14, color = colors.textSecondary }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z" />
      <Circle cx="12" cy="10" r="2.2" />
    </Svg>
  );
}

export function ClockIcon({ size = 14, color = colors.textSecondary }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Circle cx="12" cy="12" r="9" />
      <Polyline points="12 7 12 12 15.5 14" />
    </Svg>
  );
}

export function ChevronDownIcon({ size = 12, color = colors.accent }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round">
      <Polyline points="6 9 12 15 18 9" />
    </Svg>
  );
}

export function ChevronLeftIcon({ size = 14, color = colors.textMuted }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
      <Polyline points="15 6 9 12 15 18" />
    </Svg>
  );
}

export function StarIcon({ size = 15, color = colors.textPrimary, filled = false }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? colors.coralStrong : 'none'} stroke={filled ? colors.coralStrong : color} strokeWidth={2}>
      <Path d="M12 21s-6.5-4.35-9.5-8.36C.5 9.28 1.8 5 6 5c2.1 0 3.6 1.2 6 3.6C14.4 6.2 15.9 5 18 5c4.2 0 5.5 4.28 3.5 7.64C18.5 16.65 12 21 12 21z" />
    </Svg>
  );
}

export function NoteIcon({ size = 15, color = colors.textPrimary }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M4 4h13l3 3v13H4z" />
      <Path d="M15 4v5H8V4" />
    </Svg>
  );
}

export function ChatIcon({ size = 15, color = colors.textPrimary }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
    </Svg>
  );
}

export function HideIcon({ size = 15, color = colors.textPrimary }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M17.9 17.9A10.94 10.94 0 0 1 12 20c-7 0-10-8-10-8a18.5 18.5 0 0 1 4.2-5.2M9.5 4.6A9.9 9.9 0 0 1 12 4c7 0 10 8 10 8a18.4 18.4 0 0 1-2.2 3.4" />
      <Path d="M14.1 14.1a3 3 0 1 1-4.2-4.2" />
      <Line x1="2" y1="2" x2="22" y2="22" />
    </Svg>
  );
}

export function CheckIcon({ size = 15, color = colors.textPrimary, filled = false }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={filled ? colors.greenStrong : color} strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
      <Polyline points="20 6 9 17 4 12" />
    </Svg>
  );
}

export function PriceIcon({ size = 16, color = colors.green }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
      <Circle cx="12" cy="12" r="9" />
      <Path d="M9 15s1 1.5 3 1.5 3-1.5 3-1.5M9 10h.01M15 10h.01" />
    </Svg>
  );
}

export function SlidersIcon({ size = 16, color = colors.green }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
      <Line x1="4" y1="7" x2="20" y2="7" />
      <Circle cx="9" cy="7" r="1.8" fill={color} stroke="none" />
      <Line x1="4" y1="14" x2="20" y2="14" />
      <Circle cx="16" cy="14" r="1.8" fill={color} stroke="none" />
      <Line x1="4" y1="21" x2="20" y2="21" />
      <Circle cx="12" cy="21" r="1.8" fill={color} stroke="none" />
    </Svg>
  );
}

export function BellIcon({ size = 16, color = colors.accent }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <Path d="M13.7 21a2 2 0 0 1-3.4 0" />
    </Svg>
  );
}

export function PeopleIcon({ size = 16, color = colors.green }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
      <Circle cx="9" cy="8" r="3.2" />
      <Path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6" />
      <Circle cx="17.5" cy="9" r="2.6" />
      <Path d="M15.5 13.2c2.7.4 4.5 2.3 4.5 5.3" />
    </Svg>
  );
}

export function PlusHeartIcon({ size = 16, color = colors.purple }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M12 21s-6.5-4.35-9.5-8.36C.5 9.28 1.8 5 6 5c2.1 0 3.6 1.2 6 3.6C14.4 6.2 15.9 5 18 5c4.2 0 5.5 4.28 3.5 7.64C18.5 16.65 12 21 12 21z" />
      <Line x1="12" y1="9" x2="12" y2="13" />
      <Line x1="10" y1="11" x2="14" y2="11" />
    </Svg>
  );
}

export function LockIcon({ size = 13, color = colors.textSecondary }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Rect x="4" y="10" width="16" height="10" rx="2" />
      <Path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </Svg>
  );
}

export function PinIcon({ size = 18, color = colors.accent }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
      <Rect x="4" y="10" width="16" height="10" rx="2" />
      <Path d="M8 10V7a4 4 0 0 1 8 0v3" />
      <Circle cx="12" cy="15" r="1.3" fill={color} stroke="none" />
    </Svg>
  );
}

export function FingerprintIcon({ size = 42, color = colors.accent }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M12 3a6 6 0 0 0-6 6c0 3.5-.5 6-2 8" />
      <Path d="M12 3a6 6 0 0 1 6 6c0 1.5 0 2.5-.3 3.5" />
      <Path d="M8 9a4 4 0 0 1 8 0c0 4.5 1 7 2.5 9" />
      <Path d="M12 9a2.5 2.5 0 0 0-2.5 2.5c0 3-1 5.5-2.8 7.5" />
      <Path d="M12 9a2.5 2.5 0 0 1 2.5 2.5c0 1.7.3 3 .9 4.3" />
    </Svg>
  );
}

export function WhatsAppIcon({ size = 22, color = '#ffffff' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill={color}>
      <Path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M12 2C6.5 2 2 6.5 2 12c0 1.8.5 3.5 1.4 5L2 22l5.2-1.4c1.5.8 3.1 1.2 4.8 1.2 5.5 0 10-4.5 10-10S17.5 2 12 2zm0 18.2c-1.5 0-3-.4-4.3-1.2l-.3-.2-3.1.8.8-3-.2-.3C4.2 14.9 3.8 13.5 3.8 12c0-4.5 3.7-8.2 8.2-8.2s8.2 3.7 8.2 8.2-3.7 8.2-8.2 8.2z"
      />
      <Path d="M9 7.6c-.2-.5-.4-.5-.6-.5h-.5c-.2 0-.5.1-.7.3-.2.2-.9.9-.9 2.1 0 1.2.9 2.4 1 2.6.1.2 1.8 2.8 4.4 3.8 2.2.9 2.6.7 3.1.6.5 0 1.5-.6 1.7-1.2.2-.6.2-1.1.2-1.2-.1-.1-.2-.2-.5-.3l-1.8-.9c-.2-.1-.4-.2-.6.2-.2.3-.7.9-.9 1.1-.2.2-.3.2-.6.1-.3-.2-1.2-.5-2.3-1.5-.9-.8-1.4-1.7-1.6-2-.2-.3 0-.5.1-.6.1-.1.2-.3.4-.5.1-.1.2-.3.2-.5.1-.2 0-.4 0-.5-.1-.1-.5-1.3-.7-1.9z" />
    </Svg>
  );
}

// לוגו Google הרשמי (4 צבעים) - להתחברות עם Google, ראו app/login.js.
export function GoogleIcon({ size = 18 }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 48 48">
      <G>
        <Path fill="#EA4335" d="M24 9.5c3.4 0 6.4 1.2 8.8 3.5l6.5-6.5C35.3 2.6 30 0.5 24 0.5 14.6 0.5 6.5 5.9 2.6 13.8l7.6 5.9C12.1 13.5 17.6 9.5 24 9.5z" />
        <Path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.6c-.5 3-2.2 5.5-4.7 7.2l7.3 5.7C43.8 37.6 46.5 31.6 46.5 24.5z" />
        <Path fill="#FBBC05" d="M10.2 19.7a14.5 14.5 0 0 0 0 8.6l-7.6 5.9a24 24 0 0 1 0-20.4l7.6 5.9z" />
        <Path fill="#34A853" d="M24 47.5c6 0 11.3-2 15.1-5.4l-7.3-5.7c-2 1.4-4.6 2.2-7.8 2.2-6.4 0-11.9-4-13.8-9.7l-7.6 5.9C6.5 42.1 14.6 47.5 24 47.5z" />
      </G>
    </Svg>
  );
}

// סימן תפוח - להתחברות עם Apple, ראו app/login.js. מוצג רק ב-iOS.
export function AppleIcon({ size = 18, color = '#ffffff' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill={color}>
      <Path d="M16.4 1.4c.1 1.2-.4 2.4-1.1 3.3-.8.9-2 1.7-3.2 1.6-.1-1.2.4-2.5 1.1-3.3.8-.9 2.1-1.6 3.2-1.6zM20.6 17.3c-.5 1.1-.8 1.6-1.4 2.6-.9 1.4-2.2 3.1-3.8 3.1-1.4 0-1.8-.9-3.6-.9s-2.3.9-3.6.9c-1.6 0-2.9-1.6-3.8-3-2.6-4-2.9-8.7-1.3-11.2 1.1-1.8 3-2.9 4.7-2.9 1.7 0 2.8 1 4.2 1 1.4 0 2.2-1 4.2-1 1.5 0 3.1.8 4.2 2.3-3.7 2-3.1 7.3-.8 9.1z" />
    </Svg>
  );
}

export function MailIcon({ size = 16, color = colors.textSecondary }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
      <Rect x="3" y="5" width="18" height="14" rx="2.2" />
      <Path d="M4 7l8 6 8-6" />
    </Svg>
  );
}

// "רוצה לעשות" - טוגל רביעי בעמוד פרטי הפעילות, ראו app/activity/[id].js.
export function CalendarIcon({ size = 15, color = colors.textPrimary, filled = false }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={filled ? colors.purple : color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Rect x="3" y="5" width="18" height="16" rx="2.2" fill={filled ? colors.purpleTint : 'none'} />
      <Line x1="3" y1="10" x2="21" y2="10" />
      <Line x1="8" y1="3" x2="8" y2="7" />
      <Line x1="16" y1="3" x2="16" y2="7" />
    </Svg>
  );
}

export function CategoryIcon({ size = 16, color = colors.purple }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
      <Rect x="3" y="3" width="7" height="7" rx="1.2" />
      <Rect x="14" y="3" width="7" height="7" rx="1.2" />
      <Rect x="3" y="14" width="7" height="7" rx="1.2" />
      <Circle cx="17.5" cy="17.5" r="3.5" />
    </Svg>
  );
}

// 5 האייקונים הבאים - לתפריט ההמבורגר (components/Header.js), באותו סגנון קווי-אחיד בדיוק
// כמו כל האייקונים למעלה (Feather-style paths) - לא אימוג'ים.
export function HomeIcon({ size = 18, color = colors.textPrimary }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <Polyline points="9 22 9 12 15 12 15 22" />
    </Svg>
  );
}

export function HeartIcon({ size = 18, color = colors.textPrimary }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
    </Svg>
  );
}

export function UserIcon({ size = 18, color = colors.textPrimary }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <Circle cx="12" cy="7" r="4" />
    </Svg>
  );
}

export function InfoIcon({ size = 18, color = colors.textPrimary }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Circle cx="12" cy="12" r="10" />
      <Line x1="12" y1="16" x2="12" y2="12" />
      <Line x1="12" y1="8" x2="12.01" y2="8" />
    </Svg>
  );
}

export function LogOutIcon({ size = 18, color = colors.textSecondary }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <Polyline points="16 17 21 12 16 7" />
      <Line x1="21" y1="12" x2="9" y2="12" />
    </Svg>
  );
}
