FROM eclipse-temurin:21-jdk-jammy AS build
WORKDIR /src
COPY . .
RUN chmod +x gradlew && ./gradlew installDist --no-daemon

FROM eclipse-temurin:21-jre-jammy
WORKDIR /opt/agv-simulator
COPY --from=build /src/build/install/AgvSimulator/ ./
ENV SIM_MODE=server \
    SIM_HTTP_PORT=8091 \
    SIM_STATE_FILE=/opt/agv-simulator/data/fleet.json \
    SIM_SEED_DEFAULTS=false
EXPOSE 8091
CMD ["bin/AgvSimulator", "--server"]
