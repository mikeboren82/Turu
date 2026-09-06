import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import AsyncStorage from '@react-native-async-storage/async-storage';

const PIN_HASH_KEY = 'wabbit_pin_hash';
const PIN_ENABLED_KEY = 'wabbit_pin_enabled';

// expo-secure-store has no web implementation (no Keychain/Keystore equivalent in browsers) -
// on web we fall back to AsyncStorage so this can be developed/previewed there. On real devices
// (the app's actual target) this always goes through the OS-encrypted SecureStore.
const secureStorage = Platform.OS === 'web'
  ? { setItemAsync: AsyncStorage.setItem, getItemAsync: AsyncStorage.getItem, deleteItemAsync: AsyncStorage.removeItem }
  : SecureStore;

async function hashPin(pin) {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, pin);
}

export async function savePin(pin) {
  const hash = await hashPin(pin);
  await secureStorage.setItemAsync(PIN_HASH_KEY, hash);
  await AsyncStorage.setItem(PIN_ENABLED_KEY, 'true');
}

export async function verifyPin(pin) {
  const storedHash = await secureStorage.getItemAsync(PIN_HASH_KEY);
  if (!storedHash) return false;
  const hash = await hashPin(pin);
  return hash === storedHash;
}

export async function clearPin() {
  await secureStorage.deleteItemAsync(PIN_HASH_KEY);
  await AsyncStorage.removeItem(PIN_ENABLED_KEY);
}
