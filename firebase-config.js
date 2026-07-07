// ЗАМЕНИТЕ этот объект на свой — Firebase Console → Project settings →
// General → "Your apps" → Web app → SDK setup and configuration → "Config".
// Подробная инструкция, как его получить, — в README.md.

const firebaseConfig = {
  apiKey: "ВАШ_API_KEY",
  authDomain: "ваш-проект.firebaseapp.com",
  databaseURL: "https://ваш-проект-default-rtdb.firebaseio.com",
  projectId: "ваш-проект",
  storageBucket: "ваш-проект.appspot.com",
  messagingSenderId: "000000000000",
  appId: "1:000000000000:web:xxxxxxxxxxxxxxxxxxxx"
};

firebase.initializeApp(firebaseConfig);
