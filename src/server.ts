import app from './index.js';
var PORT= 3000,
    ENV='development';

app.listen(PORT, () => {
  console.log(`[Server] Running in ${ENV} mode on port ${PORT}`);
});