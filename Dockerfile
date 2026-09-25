# Use the Zenika image with Puppeteer support
FROM zenika/alpine-chrome:with-puppeteer

# Set working directory inside the container
WORKDIR /usr/src/app

# Switch to 'chrome' user before copying and installing
USER chrome

# Copy the package.json and package-lock.json for npm install
COPY --chown=chrome:chrome package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of your app files into the container
COPY --chown=chrome:chrome . .

# Expose the app port
EXPOSE 8080

# Set the command to run your app
CMD ["npm", "run", "start"]
