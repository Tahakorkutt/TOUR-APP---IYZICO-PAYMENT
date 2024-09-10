const express = require("express");
const bodyParser = require("body-parser");
const https = require("https");
const request = require("request");
const axios = require("axios");
const Iyzipay = require('iyzipay');
const mysql = require('mysql2');
const crypto = require('crypto');


const cors = require("cors");
const app = express();
const env = require("dotenv").config();

// Router tanımlaması
const Router = express.Router();

app.use(cors()); // CORS middleware burada kullanılıyor
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());


const port = process.env.PORT || 4000;

// Veritabanı bağlantısı
const connection = mysql.createConnection({
 

  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME


});
connection.connect((err) => {
  if (err) {
    console.error('Veritabanına bağlanırken hata oluştu:', err.stack);
    return;
  }
  console.log('Veritabanına başarıyla bağlanıldı.');

  // Tabloyu oluştur
  const createPaymentInfoTableQuery = `
    CREATE TABLE IF NOT EXISTS payment_info (
      id INT AUTO_INCREMENT PRIMARY KEY,
      cardHolderName VARCHAR(255) NOT NULL,
      cardNumber VARCHAR(255) NOT NULL,
      expireMonth INT NOT NULL,
      expireYear INT NOT NULL,
      cvc VARCHAR(255) NOT NULL,
      currency VARCHAR(10) NOT NULL,
      tourId INT NOT NULL,
      price DECIMAL(10, 2),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `;

  const createBuyerInfoTableQuery = `
    CREATE TABLE IF NOT EXISTS buyer_info (
      id INT AUTO_INCREMENT PRIMARY KEY,
      userId INT NOT NULL,
      firstName VARCHAR(255) NOT NULL,
      lastName VARCHAR(255) NOT NULL,
      email VARCHAR(255) NOT NULL,
      telNumber VARCHAR(20) NOT NULL,
      identityNo VARCHAR(20),
      address TEXT NOT NULL,
      city VARCHAR(255) NOT NULL,
      country VARCHAR(255) NOT NULL,
      cardHolderName VARCHAR(255) NOT NULL,
      cardNumber VARCHAR(255) NOT NULL,
      expireMonth INT NOT NULL,
      expireYear INT NOT NULL,
      cvc VARCHAR(255) NOT NULL,
      currency VARCHAR(10) NOT NULL,
      tourId INT NOT NULL,
      price DECIMAL(10, 2),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `;

  // Tabloyu oluştur
  connection.query(createPaymentInfoTableQuery, (err) => {
    if (err) {
      console.error('payment_info tablosu oluşturulurken hata oluştu:', err.stack);
      return;
    }
    console.log('payment_info tablosu başarıyla oluşturuldu.');
  });

  connection.query(createBuyerInfoTableQuery, (err) => {
    if (err) {
      console.error('buyer_info tablosu oluşturulurken hata oluştu:', err.stack);
      return;
    }
    console.log('buyer_info tablosu başarıyla oluşturuldu.');
  });
});

// İyzico API yapılandırması
const iyzipay = new Iyzipay({
  apiKey: 'sandbox-jytZwEyruPca7g8Ms9ERgzU2IdMizq6r',
  secretKey: 'sandbox-pKj5QZS6bG1qrA6hXRcERvkrgoXJYRgb',
  uri: 'https://sandbox-api.iyzipay.com'
});

// Hash fonksiyonu
function hashData(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

// Ödeme işlemi için pay fonksiyonu
async function pay(req, res) {
  try {
    const { cardHolderName, cardNumber, expireMonth, expireYear, cvc, currency, tourId, userId } = req.body;

    // Veritabanından tourId'ye göre fiyat bilgisi alınması
    const [rows] = await connection.promise().query('SELECT price FROM tourgeneralinfo WHERE tourId = ?', [tourId]);

    if (rows.length === 0) {
      return res.status(404).json({ status: 'error', message: 'Geçersiz tourId' });
    }

    const price = rows[0].price;

    // Kullanıcı bilgilerini alın
    const [userRows] = await connection.promise().query('SELECT * FROM users WHERE usersId = ?', [userId]);

    if (userRows.length === 0) {
      return res.status(404).json({ status: 'error', message: 'Geçersiz kullanıcı ID' });
    }

    const user = userRows[0];

    const hashedCardNumber = hashData(cardNumber);
    const hashedCvc = hashData(cvc);

    const conversationId = userId;

    // Ödeme bilgilerini payment_info tablosuna kaydeder
    await connection.promise().query(
      'INSERT INTO payment_info (cardHolderName, cardNumber, expireMonth, expireYear, cvc, currency, tourId, price) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [cardHolderName, hashedCardNumber, expireMonth, expireYear, hashedCvc, currency, tourId, price]
    );

    // Kullanıcı ve ödeme bilgilerini buyer_info tablosuna kaydeder
    await connection.promise().query(
      'INSERT INTO buyer_info (userId, firstName, lastName, email, telNumber, identityNo, address, city, country, cardHolderName, cardNumber, expireMonth, expireYear, cvc, currency, tourId, price) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [userId, user.firstName, user.lastName, user.email, user.telNumber, user.identityNo, user.address, user.city, user.country, cardHolderName, hashedCardNumber, expireMonth, expireYear, hashedCvc, currency, tourId, price]
    );

    // buyer_info tablosunu güncelleme
    await connection.promise().query(
      'UPDATE buyer_info b JOIN tourgeneralinfo t ON b.tourId = t.tourId SET b.product = t.product'
    );

    let selectedCurrency;
    switch (currency) {
      case 'TRY':
        selectedCurrency = Iyzipay.CURRENCY.TRY;
        break;
      case 'EURO':
        selectedCurrency = Iyzipay.CURRENCY.EUR;
        break;
      case 'USD':
        selectedCurrency = Iyzipay.CURRENCY.USD;
        break;
      default:
        return res.status(400).json({ status: 'error', message: 'Geçersiz para birimi' });
    }

    const request = {
      locale: Iyzipay.LOCALE.TR,
      currency: selectedCurrency,
      conversationId: conversationId,
      price: price,
      paidPrice: price,
      installment: '1',
      basketId: 'B67832',
      paymentChannel: Iyzipay.PAYMENT_CHANNEL.WEB,
      paymentGroup: Iyzipay.PAYMENT_GROUP.PRODUCT,
      paymentCard: {
        cardHolderName,
        cardNumber, // İyzico'ya gönderirken hashlenmemiş kart numarası
        expireMonth,
        expireYear,
        cvc, // İyzico'ya gönderirken hashlenmemiş CVC
      },
      buyer: {
        id: user.usersId,
        name: user.firstName,
        surname: user.lastName,
        gsmNumber: user.telNumber,
        email: user.email,
        identityNumber: user.identityNo,
        registrationAddress: user.address,
        city: user.city,
        country: user.country,
      },
      shippingAddress: {
        contactName: user.firstName + ' ' + user.lastName,
        city: user.city,
        country: user.country,
        address: user.address,
      },
      billingAddress: {
        contactName: user.firstName + ' ' + user.lastName,
        city: user.city,
        country: user.country,
        address: user.address,
      },
      basketItems: [
        {
          id: 'BI101',
          name: 'Binocular',
          category1: 'Collectibles',
          itemType: Iyzipay.BASKET_ITEM_TYPE.PHYSICAL,
          price: price,
        },
      ],
    };

    iyzipay.payment.create(request, (err, result) => {
      if (err) {
        console.error('Ödeme işlemi sırasında hata oluştu:', err);
        return res.status(500).send(err);
      }

      if (result.status === 'success') {
        return res.status(200).json({ status: 'success', message: 'Ödeme Başarılı' });
      } else {
        console.error('Ödeme başarısız:', result.errorMessage);
        return res.status(500).json({ status: 'error', message: 'Ödeme başarısız', error: result.errorMessage });
      }
    });
  } catch (e) {
    console.error('İşlem Başarısız:', e);
    res.status(500).send(`İşlem Başarısız: ${e}`);
  }
}




app.get('/payment_info', (req, res) => {
  // Users tablosundaki verileri çek
  connection.query('SELECT * FROM payment_info', (err, results) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    // Verileri JSON formatında döndür
    res.json(results);
  });
});


app.get('/tours', (req, res) => {
  // Users tablosundaki verileri çek
  connection.query('SELECT * FROM tours', (err, results) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    // Verileri JSON formatında döndür
    res.json(results);
  });
});

app.get('/tourgeneralInfo', (req, res) => {
  // Users tablosundaki verileri çek
  connection.query('SELECT * FROM tourgeneralinfo', (err, results) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    // Verileri JSON formatında döndür
    res.json(results);
  });
});

app.get('/users', (req, res) => {
  // Users tablosundaki verileri çek
  connection.query('SELECT * FROM users', (err, results) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    // Verileri JSON formatında döndür
    res.json(results);
  });
});


app.get('/buyer_info', (req, res) => {
  connection.query('SELECT * FROM buyer_info', (err, results) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    // Verileri JSON formatında döndür
    res.json(results);
  });
});

  app.post('/pay',pay)




  

app.use(express.json());

const startServer = () => {
  try {

    app.listen(port, () => console.log(`Server started listening on ${port}`));
  } catch (error) {
    console.log(error);
  }
};




startServer();
