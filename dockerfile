FROM node:16

WORKDIR /app

COPY package.json .

RUN npm install

COPY . .

EXPOSE 8080
EXPOSE 8000

CMD ["node", "src/index.js"]