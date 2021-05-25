import NetInfo from '@react-native-community/netinfo';
import {EV, EVENTS} from 'notes-core/common';
import React, {useEffect} from 'react';
import {Appearance, AppState, Linking, Platform} from 'react-native';
import RNExitApp from 'react-native-exit-app';
import * as RNIap from 'react-native-iap';
import {enabled} from 'react-native-privacy-snapshot';
import SplashScreen from 'react-native-splash-screen';
import {updateEvent} from './src/components/DialogManager/recievers';
import {useTracked} from './src/provider';
import {Actions} from './src/provider/Actions';
import Backup from './src/services/Backup';
import BiometricService from './src/services/BiometricService';
import {
  eSendEvent,
  eSubscribeEvent,
  eUnSubscribeEvent,
  ToastEvent,
} from './src/services/EventManager';
import {
  clearMessage,
  setEmailVerifyMessage,
  setLoginMessage,
} from './src/services/Message';
import Navigation from './src/services/Navigation';
import PremiumService from './src/services/PremiumService';
import SettingsService from './src/services/SettingsService';
import Sync from './src/services/Sync';
import {APP_VERSION, doInBackground, editing} from './src/utils';
import {updateStatusBarColor} from './src/utils/Colors';
import {db} from './src/utils/DB';
import {
  eClearEditor,
  eCloseProgressDialog,
  eOpenLoginDialog,
  eOpenProgressDialog,
  refreshNotesPage,
} from './src/utils/Events';
import {MMKV} from './src/utils/mmkv';
import Storage from './src/utils/storage';
import {sleep} from './src/utils/TimeUtils';
import {getNote, getWebviewInit} from './src/views/Editor/Functions';

let prevTransactionId = null;
let subsriptionSuccessListener;
let subsriptionErrorListener;
let isUserReady = false;
async function storeAppState() {
  if (editing.currentlyEditing) {
    let state = JSON.stringify({
      editing: editing.currentlyEditing,
      note: getNote(),
      movedAway: editing.movedAway,
      timestamp: Date.now(),
    });
    await MMKV.setItem('appState', state);
  }
}

async function checkIntentState() {
  try {
    let intent = await MMKV.getItem('notesAddedFromIntent');
    if (intent) {
      if (Platform.OS === 'ios') {
        await db.init();
        await db.notes.init();
      }
      eSendEvent('webviewreset');
      updateEvent({type: Actions.NOTES});
      eSendEvent(refreshNotesPage);
      MMKV.removeItem('notesAddedFromIntent');
      updateEvent({type: Actions.ALL});
      eSendEvent(refreshNotesPage);
    }
  } catch (e) {}
}

async function reconnectSSE(connection) {
  if (!isUserReady) {
    return;
  }
  let state = connection;
  try {
    if (!state) {
      state = await NetInfo.fetch();
    }

    let user = await db.user.getUser();
    if (user && state.isConnected && state.isInternetReachable) {
      await doInBackground(async () => {
        await db.connectSSE();
      });
    }
  } catch (e) {}
}

let prevState = null;
let showingDialog = false;

let removeInternetStateListener;
export const AppRootEvents = React.memo(
  () => {
    const [state, dispatch] = useTracked();
    const {loading} = state;

    useEffect(() => {
      Appearance.addChangeListener(SettingsService.setTheme);
      Linking.addEventListener('url', onUrlRecieved);
      EV.subscribe(EVENTS.appRefreshRequested, onSyncComplete);
      EV.subscribe(EVENTS.databaseSyncRequested, partialSync);
      EV.subscribe(EVENTS.userLoggedOut, onLogout);
      EV.subscribe(EVENTS.userEmailConfirmed, onEmailVerified);
      EV.subscribe(EVENTS.userCheckStatus, PremiumService.onUserStatusCheck);
      EV.subscribe(EVENTS.userSubscriptionUpdated, onAccountStatusChange);
      EV.subscribe(EVENTS.noteRemoved, onNoteRemoved);
      eSubscribeEvent('userLoggedIn', setCurrentUser);
      removeInternetStateListener = NetInfo.addEventListener(
        onInternetStateChanged,
      );
      return () => {
        eUnSubscribeEvent('userLoggedIn', setCurrentUser);
        EV.unsubscribe(EVENTS.appRefreshRequested, onSyncComplete);
        EV.unsubscribe(EVENTS.databaseSyncRequested, partialSync);
        EV.unsubscribe(EVENTS.userLoggedOut, onLogout);
        EV.unsubscribe(EVENTS.userEmailConfirmed, onEmailVerified);
        EV.unsubscribe(EVENTS.noteRemoved, onNoteRemoved);
        EV.unsubscribe(
          EVENTS.userCheckStatus,
          PremiumService.onUserStatusCheck,
        );
        EV.unsubscribe(EVENTS.userSubscriptionUpdated, onAccountStatusChange);

        Appearance.removeChangeListener(SettingsService.setTheme);
        Linking.removeEventListener('url', onUrlRecieved);
      };
    }, []);

    const onNoteRemoved = async id => {
      try {
        await db.notes.remove(id);
        Navigation.setRoutesToUpdate([
          Navigation.routeNames.Favorites,
          Navigation.routeNames.Notes,
          Navigation.routeNames.NotesPage,
          Navigation.routeNames.Trash,
          Navigation.routeNames.Notebook,
        ]);
        eSendEvent(eClearEditor);
      } catch (e) {}
    };

    useEffect(() => {
      if (!loading) {
        AppState.addEventListener('change', onAppStateChanged);
        (async () => {
          try {
            let url = await Linking.getInitialURL();
            if (url?.startsWith('https://app.notesnook.com/account/verified')) {
              await onEmailVerified();
            }
            await setCurrentUser();
            await Backup.checkAndRun();
            let version = await db.version();
            if (version.mobile > APP_VERSION) {
              eSendEvent('updateDialog', ver);
            }
          } catch (e) {
            console.log(e);
          }
        })();
      }
      return () => {
        removeInternetStateListener && removeInternetStateListener();
        AppState.removeEventListener('change', onAppStateChanged);
        unsubIAP();
      };
    }, [loading]);

    const onInternetStateChanged = async state => {
      reconnectSSE(state);
    };

    const onSyncComplete = async () => {
      dispatch({type: Actions.ALL});
      dispatch({type: Actions.LAST_SYNC, lastSync: await db.lastSynced()});
    };

    const onUrlRecieved = async res => {
      let url = res ? res.url : '';
      try {
        if (url.startsWith('https://app.notesnook.com/account/verified')) {
          await onEmailVerified();
        } else {
          return;
        }
      } catch (e) {}
    };

    const onEmailVerified = async () => {
      let user = await db.user.getUser();
      dispatch({type: Actions.USER, user: user});
      if (!user) return;
      await PremiumService.setPremiumStatus();
      let message =
        user?.subscription?.type === 2
          ? 'Thank you for signing up for Notesnook Beta Program. Enjoy all premium features for free for the next 3 months.'
          : 'Your Notesnook Pro Trial has been activated. Enjoy all premium features for the next 14 days for free!';
      eSendEvent(eOpenProgressDialog, {
        title: 'Email confirmed!',
        paragraph: message,
        noProgress: true,
      });

      if (user?.isEmailConfirmed) {
        clearMessage(dispatch);
      }
    };

    const attachIAPListeners = async () => {
      await RNIap.initConnection()
        .catch(e => {
          console.log(e);
        })
        .then(async () => {
          subsriptionSuccessListener = RNIap.purchaseUpdatedListener(
            onSuccessfulSubscription,
          );
          subsriptionErrorListener = RNIap.purchaseErrorListener(
            onSubscriptionError,
          );
        });
    };

    const onAccountStatusChange = async userStatus => {
      console.log('account status', userStatus, PremiumService.get());
      if (!PremiumService.get() && userStatus.type === 5) {
        eSendEvent(eOpenProgressDialog, {
          title: 'Notesnook Pro',
          paragraph: `Your Notesnook Pro subscription has been successfully activated.`,
          action: async () => {
            eSendEvent(eCloseProgressDialog);
          },
          icon: 'check',
          actionText: 'Continue',
          noProgress: true,
        });
      }
      await PremiumService.setPremiumStatus();
    };

    const partialSync = async () => {
      try {
        dispatch({type: Actions.SYNCING, syncing: true});
        await doInBackground(async () => {
          await db.sync(false);
        });
        dispatch({type: Actions.LAST_SYNC, lastSync: await db.lastSynced()});
      } catch (e) {
        dispatch({type: Actions.SYNCING, syncing: false});
      } finally {
        dispatch({type: Actions.SYNCING, syncing: false});
      }
    };

    const onLogout = async reason => {
      dispatch({type: Actions.USER, user: null});
      dispatch({type: Actions.CLEAR_ALL});
      dispatch({type: Actions.SYNCING, syncing: false});
      setLoginMessage(dispatch);
      await sleep(500);
      await PremiumService.setPremiumStatus();
      await Storage.write('introCompleted', 'true');

      eSendEvent(eOpenProgressDialog, {
        title: reason ? reason : 'User logged out',
        paragraph: `You have been logged out of your account.`,
        action: async () => {
          eSendEvent(eCloseProgressDialog);
          await sleep(50);
          eSendEvent(eOpenLoginDialog);
        },
        icon: 'logout',
        actionText: 'Login',
        noProgress: true,
      });
    };

    unsubIAP = () => {
      if (subsriptionSuccessListener) {
        subsriptionSuccessListener?.remove();
        subsriptionSuccessListener = null;
      }
      if (subsriptionErrorListener) {
        subsriptionErrorListener?.remove();
        subsriptionErrorListener = null;
      }
    };

    const setCurrentUser = async login => {
      try {
        let user = await db.user.getUser();
        if (user) {
          dispatch({type: Actions.USER, user: user});
          clearMessage(dispatch);
          await PremiumService.setPremiumStatus();
          attachIAPListeners();
          await Sync.run();
          await doInBackground(async () => {
            user = await db.user.fetchUser(true);
          });
          if (!user.isEmailConfirmed) {
            setEmailVerifyMessage(dispatch);
            return;
          }
          dispatch({type: Actions.USER, user: user});
        } else {
          await PremiumService.setPremiumStatus();
          setLoginMessage(dispatch);
        }
      } catch (e) {
        let user = await db.user.getUser();
        if (user && !user.isEmailConfirmed) {
          setEmailVerifyMessage(dispatch);
        } else if (!user) {
          setLoginMessage(dispatch);
        } else {
          console.log('unknown error', e);
        }
      } finally {
        isUserReady = true;
        if (login) {
          eSendEvent(eCloseProgressDialog);
        }
      }
    };

    const onSuccessfulSubscription = async subscription => {
      const receipt = subscription.transactionReceipt;
      if (prevTransactionId === subscription.transactionId) {
        return;
      }
      await processReceipt(receipt);
    };

    const onSubscriptionError = async error => {
      ToastEvent.show({
        heading: 'Failed to subscribe',
        type: 'error',
        message: error.message,
        context: 'local',
      });

      if (Platform.OS === 'ios') {
        await RNIap.clearTransactionIOS();
      }
    };

    const processReceipt = async receipt => {
      if (receipt) {
        if (Platform.OS === 'ios') {
          let user = await db.user.getUser();
          if (!user) return;
          fetch('https://payments.streetwriters.co/apple/verify', {
            method: 'POST',
            body: JSON.stringify({
              receipt_data: receipt,
              user_id: user.id,
            }),
            headers: {
              'Content-Type': 'application/json',
            },
          })
            .then(async r => {
              let text = await r.text();
              console.log(r.ok, text);
              if (!r.ok) {
                if (text === 'Receipt already expired.') {
                  console.log('RNIap.clearTransactionIOS');
                  await RNIap.clearTransactionIOS();
                }
                return;
              }
              console.log('Success', 'RNIap.finishTransactionIOS');
              await RNIap.finishTransactionIOS(prevTransactionId);
              await RNIap.clearTransactionIOS();
            })
            .catch(e => {
              console.log(e, 'ERROR');
            });
        }
      }
    };

    const onAppStateChanged = async state => {
      if (state === 'active') {
        updateStatusBarColor();
        if (
          SettingsService.get().appLockMode !== 'background' &&
          !SettingsService.get().privacyScreen
        ) {
          enabled(false);
        }

        if (SettingsService.get().appLockMode === 'background') {
          if (prevState === 'background' && !showingDialog) {
            showingDialog = true;
            prevState = 'active';
            if (Platform.OS === 'android') {
              SplashScreen.show();
            } else {
              eSendEvent('load_overlay', 'hide');
            }

            let result = await BiometricService.validateUser(
              'Unlock to access your notes',
            );
            if (result) {
              showingDialog = false;
              if (Platform.OS === 'android') {
                SplashScreen.hide();
              } else {
                eSendEvent('load_overlay', 'show');
              }
            } else {
              RNExitApp.exitApp();
              return;
            }
          }
        }
        prevState = 'active';
        await reconnectSSE();
        await checkIntentState();
        if (getWebviewInit()) {
          await MMKV.removeItem('appState');
        }
        let user = await db.user.getUser();
        if (user && !user.isEmailConfirmed) {
          try {
            let user = await db.user.fetchUser(true);
            if (user.isEmailConfirmed) {
              onEmailVerified(dispatch);
            }
          } catch (e) {}
        }
      } else {
        prevState = 'background';
        if (
          getNote()?.locked &&
          SettingsService.get().appLockMode === 'background'
        ) {
          eSendEvent(eClearEditor);
        }
        await storeAppState();
        if (
          SettingsService.get().privacyScreen ||
          SettingsService.get().appLockMode === 'background'
        ) {
          enabled(true);
        }
      }
    };

    return <></>;
  },
  () => true,
);
