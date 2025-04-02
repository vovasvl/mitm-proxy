FROM node:16

WORKDIR /app

COPY package.json .
RUN npm install

COPY . .

RUN rm -rf /app/src/certs

RUN chmod +x /app/src/gen_ca.sh

RUN cd /app/src && ./gen_ca.sh

RUN chmod 644 /app/src/cert.key
RUN chmod 644 /app/src/ca.crt
RUN chmod 600 /app/src/ca.key
RUN chmod -R 755 /app/src/certs

EXPOSE 8080
EXPOSE 8000

CMD ["node", "src/index.js"]